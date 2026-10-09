import { createHash } from 'node:crypto';
import { many, one, query, withTransaction } from '../db/pool.js';
import { logger, maskNumber } from '../lib/logger.js';
import { metrics } from '../lib/metrics.js';
import { getFreePBX } from '../freepbx/index.js';
import type { FreePBXExtension, FreePBXInboundRoute } from '../freepbx/types.js';
import { writeAudit } from '../services/audit.service.js';
import { applyInboundRoute, removeInboundRouteForNumber, verifyRouteMapping, type RouteMappingRow } from '../services/routing.service.js';
import { expireNumbers, finaliseStuckAssignments } from '../services/assignment.service.js';
import { releaseStaleReservations } from '../services/inventory.service.js';
import { requeueStuckJobs } from '../services/pbxJob.service.js';
import { getBool, getNumber } from '../services/settings.service.js';
import { enqueueAdminNotification } from '../services/notification.service.js';
import { parseExtensionFromDestinationConnection } from '../services/routing.service.js';

/**
 * RECONCILIATION WORKER (spec §31)
 * ================================
 * Every few minutes:
 *
 *   database assignments  VS  FreePBX extensions/routes
 *
 * Detects: missing routes, stale routes, wrong destinations, deleted
 * extensions, numbers assigned in the DB but missing in the PBX, and PBX routes
 * that do not exist in our inventory.
 *
 * SAFETY POLICY (the important part)
 * ----------------------------------
 * Safe, additive fixes are applied automatically when `reconcile.auto_fix_safe`
 * is true:
 *   * recreate a route that is missing in the PBX (the DID and destination are
 *     known; creating it can only restore intended service),
 *   * re-point a route whose destination drifted,
 *   * recover a stuck reservation.
 *
 * Destructive or ambiguous fixes are NEVER automatic; they are reported for an
 * admin to action:
 *   * deleting a PBX route that has no inventory row (it may belong to another
 *     system or a manual configuration),
 *   * deleting PBX extensions,
 *   * anything touching a number that is currently assigned to a user.
 */

export interface ReconcileSummary {
  runId: string;
  extensionsSeen: number;
  routesSeen: number;
  findings: number;
  critical: number;
  autoFixed: number;
  details: Array<{ type: string; severity: string; detail: string }>;
}

export async function runReconciliation(opts: { autoFix?: boolean; alert?: boolean } = {}): Promise<ReconcileSummary> {
  const autoFix = opts.autoFix ?? (await getBool('reconcile.auto_fix_safe', true));
  const alert = opts.alert ?? (await getBool('reconcile.alert_admins', true));

  const pbx = getFreePBX();

  const runRes = await query<{ id: string }>("INSERT INTO reconciliation_runs (status) VALUES ('RUNNING') RETURNING id");
  const runId = runRes.rows[0]!.id;

  const details: ReconcileSummary['details'] = [];
  let autoFixed = 0;

  const record = async (
    severity: 'INFO' | 'WARNING' | 'CRITICAL',
    findingType: string,
    detail: string,
    extra: Partial<{
      entityType: string;
      entityId: string | null;
      did: string | null;
      extension: string | null;
      suggestedAction: string;
      autoFixable: boolean;
    }> = {},
  ): Promise<void> => {
    await query(
      `INSERT INTO reconciliation_findings
         (run_id, severity, finding_type, entity_type, entity_id, did, extension, detail, suggested_action, auto_fixable)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        runId,
        severity,
        findingType,
        extra.entityType ?? null,
        extra.entityId ?? null,
        extra.did ?? null,
        extra.extension ?? null,
        detail,
        extra.suggestedAction ?? null,
        extra.autoFixable ?? false,
      ],
    );
    details.push({ type: findingType, severity, detail });
  };

  try {
    // ---------------------------------------------------------------------
    // Gather reality from the PBX
    // ---------------------------------------------------------------------
    let extensions: FreePBXExtension[] = [];
    let routes: FreePBXInboundRoute[] = [];
    try {
      extensions = await pbx.getAllExtensions();
      routes = await pbx.getAllInboundRoutes();
    } catch (err) {
      await query("UPDATE reconciliation_runs SET status = 'FAILED', finished_at = now(), error = $2 WHERE id = $1", [
        runId,
        (err as Error).message,
      ]);
      throw err;
    }

    const pbxExtensions = new Set(extensions.map((e) => e.extensionId));
    const pbxRoutesByDid = new Map<string, FreePBXInboundRoute>();
    const pbxRouteIndex = new Map<string, FreePBXInboundRoute>();
    for (const route of routes) {
      if (route.extension) pbxRoutesByDid.set(route.extension, route);
      pbxRouteIndex.set(route.id, route);
    }

    // Snapshot for the admin UI.
    await withTransaction(async (client) => {
      await client.query('DELETE FROM pbx_inventory_snapshot WHERE kind = $1', ['EXTENSION']);
      await client.query('DELETE FROM pbx_inventory_snapshot WHERE kind = $1', ['INBOUND_ROUTE']);
      for (const ext of extensions) {
        await client.query(
          `INSERT INTO pbx_inventory_snapshot (kind, external_id, extension, description, raw)
           VALUES ('EXTENSION',$1,$2,$3,$4::jsonb) ON CONFLICT (kind, external_id) DO NOTHING`,
          [ext.id ?? ext.extensionId, ext.extensionId, ext.user?.name ?? null, JSON.stringify(ext)],
        );
      }
      for (const route of routes) {
        await client.query(
          `INSERT INTO pbx_inventory_snapshot (kind, external_id, extension, cidnum, destination, description, raw)
           VALUES ('INBOUND_ROUTE',$1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT (kind, external_id) DO NOTHING`,
          [
            route.id,
            route.extension ?? null,
            route.cidnum ?? null,
            route.destinationConnection ?? null,
            route.description ?? null,
            JSON.stringify(route),
          ],
        );
      }
    });

    // ---------------------------------------------------------------------
    // Check 1: every active assignment must have an extension on the PBX
    // ---------------------------------------------------------------------
    const assigned = await many<{
      number_id: string;
      phone_number: string;
      sip_extension: string | null;
      assigned_user_id: string | null;
      status: string;
    }>(
      `SELECT id AS number_id, phone_number, sip_extension, assigned_user_id, status
         FROM numbers
        WHERE status IN ('ASSIGNED','SUSPENDED') AND deleted_at IS NULL`,
    );

    for (const row of assigned) {
      if (!row.sip_extension) {
        await record('CRITICAL', 'EXTENSION_NOT_RECORDED', `Number ${maskNumber(row.phone_number)} is ${row.status} but has no SIP extension recorded`, {
          entityType: 'number',
          entityId: row.number_id,
          did: row.phone_number,
          suggestedAction: 'Reassign the number so a SIP account is attached.',
        });
        continue;
      }
      if (!pbxExtensions.has(row.sip_extension)) {
        await record(
          'CRITICAL',
          'EXTENSION_MISSING_IN_PBX',
          `Extension ${row.sip_extension} for ${maskNumber(row.phone_number)} does not exist on the PBX`,
          {
            entityType: 'number',
            entityId: row.number_id,
            did: row.phone_number,
            extension: row.sip_extension,
            suggestedAction: 'Recreate the extension (or release and reassign the number). Not auto-fixed: the user may have re-registered elsewhere.',
            autoFixable: false,
          },
        );
      }
    }

    // ---------------------------------------------------------------------
    // Check 2: DB route mappings vs PBX routes
    // ---------------------------------------------------------------------
    const mappings = await many<RouteMappingRow>(
      `SELECT * FROM inbound_route_mappings WHERE deleted_at IS NULL AND status <> 'REMOVED'`,
    );

    for (const mapping of mappings) {
      // One bad route must never kill the whole run (2026-10-08 incident: a
      // stale fixture route made every run throw, and every interval produced
      // a ❌ DM). Per-mapping problems become findings; the run goes on.
      let verification: Awaited<ReturnType<typeof verifyRouteMapping>>;
      try {
        // Membership lookup against the list fetched at bootstrap: the by-id
        // query 500s for missing routes on this build, never read as absence.
        verification = await verifyRouteMapping(mapping, { routeIndex: pbxRouteIndex });
      } catch (err) {
        await record('WARNING', 'ROUTE_VERIFY_FAILED', `Could not verify route for DID ${maskNumber(mapping.did_match_pattern)}: ${(err as Error).message}`, {
          entityType: 'route',
          entityId: mapping.id,
          did: mapping.did_match_pattern,
          suggestedAction: 'None - the next run retries; investigate if it persists.',
        });
        continue;
      }

      if (verification.state === 'OK') {
        await query("UPDATE inbound_route_mappings SET drift_state = 'OK' WHERE id = $1", [mapping.id]);
        continue;
      }

      if (verification.state === 'UNAVAILABLE') {
        await record('WARNING', 'ROUTE_NOT_VERIFIABLE', `${verification.detail} (DID ${maskNumber(mapping.did_match_pattern)})`, {
          entityType: 'route',
          entityId: mapping.id,
          did: mapping.did_match_pattern,
        });
        continue;
      }

      if (verification.state === 'MISSING_IN_PBX') {
        // Is this mapping still attached to a live assignment, or an orphan
        // left behind by a deleted user? Auto-repair ONLY the live kind -
        // recreating a route for a deleted user just re-points real traffic at
        // a ghost, and re-creating towards a deleted extension cannot work.
        const owner = await one<{ number_status: string; user_status: string | null }>(
          `SELECT n.status AS number_status, u.status AS user_status
             FROM inbound_route_mappings m
             LEFT JOIN numbers n ON n.id = m.number_id
             LEFT JOIN users u ON u.id = n.assigned_user_id
            WHERE m.id = $1`,
          [mapping.id],
        );
        const orphan = !owner || owner.number_status !== 'ASSIGNED' || (owner.user_status !== null && owner.user_status !== 'ACTIVE');
        const extensionAlive = Boolean(mapping.destination_extension && pbxExtensions.has(mapping.destination_extension));

        await query("UPDATE inbound_route_mappings SET drift_state = 'MISSING_IN_PBX' WHERE id = $1", [mapping.id]);
        if (orphan || !extensionAlive) {
          await record('CRITICAL', 'ROUTE_STALE_ORPHANED', `Route for DID ${maskNumber(mapping.did_match_pattern)} is gone from the PBX and its ${orphan ? 'owner is no longer an active assignment' : `destination extension ${mapping.destination_extension} no longer exists`} - not auto-recreated.`, {
            entityType: 'route',
            entityId: mapping.id,
            did: mapping.did_match_pattern,
            extension: mapping.destination_extension,
            suggestedAction: 'Release the orphaned number so it returns to inventory (admin panel -> users/numbers), or delete this mapping.',
            autoFixable: false,
          });
          continue;
        }

        await record('CRITICAL', 'ROUTE_MISSING_IN_PBX', `${verification.detail} (DID ${maskNumber(mapping.did_match_pattern)})`, {
          entityType: 'route',
          entityId: mapping.id,
          did: mapping.did_match_pattern,
          suggestedAction: 'Recreate the inbound route.',
          autoFixable: true,
        });

        if (autoFix && mapping.destination_extension) {
          try {
            await applyInboundRoute({
              numberId: mapping.number_id,
              assignmentId: mapping.assignment_id,
              didPattern: mapping.did_match_pattern,
              extension: mapping.destination_extension,
              description: `recreated by reconciler ${new Date().toISOString()}`,
            });
            autoFixed += 1;
            await writeAudit({
              actorType: 'WORKER',
              action: 'RECONCILIATION_FIX_APPLIED',
              targetType: 'route',
              targetId: mapping.id,
              targetRef: mapping.did_match_pattern,
              metadata: { fix: 'recreate_route', extension: mapping.destination_extension },
            });
          } catch (err) {
            await record('CRITICAL', 'ROUTE_RECREATE_FAILED', `Could not recreate route for ${maskNumber(mapping.did_match_pattern)}: ${(err as Error).message}`, {
              entityType: 'route',
              entityId: mapping.id,
              did: mapping.did_match_pattern,
            });
          }
        }
        continue;
      }

      // MISMATCH: the route exists but points somewhere else.
      await query("UPDATE inbound_route_mappings SET drift_state = 'MISMATCH' WHERE id = $1", [mapping.id]);
      await record('WARNING', 'ROUTE_DESTINATION_MISMATCH', verification.detail, {
        entityType: 'route',
        entityId: mapping.id,
        did: mapping.did_match_pattern,
        extension: mapping.destination_extension,
        suggestedAction: 'Re-point the route at the correct extension.',
        autoFixable: true,
      });

      if (autoFix && mapping.destination_extension) {
        try {
          const applied = await applyInboundRoute({
            numberId: mapping.number_id,
            assignmentId: mapping.assignment_id,
            didPattern: mapping.did_match_pattern,
            extension: mapping.destination_extension,
            description: `corrected by reconciler ${new Date().toISOString()}`,
          });
          autoFixed += 1;
          logger.warn({ did: maskNumber(mapping.did_match_pattern), routeId: applied.mapping.freepbx_route_id }, 'reconciler re-pointed a drifted route');
        } catch (err) {
          await record('CRITICAL', 'ROUTE_FIX_FAILED', `Could not fix drift: ${(err as Error).message}`, { entityType: 'route', entityId: mapping.id });
        }
      }
    }

    // ---------------------------------------------------------------------
    // Check 3: numbers marked ASSIGNED with NO active mapping at all
    // ---------------------------------------------------------------------
    const orphanAssignments = await many<{ id: string; phone_number: string; sip_extension: string | null }>(
      `SELECT n.id, n.phone_number, n.sip_extension
         FROM numbers n
        WHERE n.status = 'ASSIGNED' AND n.deleted_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM inbound_route_mappings m
             WHERE m.number_id = n.id AND m.deleted_at IS NULL AND m.status = 'ACTIVE'
          )`,
    );
    for (const orphan of orphanAssignments) {
      await record('CRITICAL', 'NUMBER_WITHOUT_ROUTE', `Assigned number ${maskNumber(orphan.phone_number)} has no active inbound route - calls cannot reach it`, {
        entityType: 'number',
        entityId: orphan.id,
        did: orphan.phone_number,
        extension: orphan.sip_extension,
        suggestedAction: 'Recreate the route (usually auto-fixed on the next run when the destination is known).',
        autoFixable: Boolean(orphan.sip_extension),
      });

      if (autoFix && orphan.sip_extension) {
        try {
          await applyInboundRoute({
            numberId: orphan.id,
            assignmentId: null,
            didPattern: orphan.phone_number.replace('+', ''),
            extension: orphan.sip_extension,
            description: `reconciler repair ${new Date().toISOString()}`,
          });
          autoFixed += 1;
        } catch (err) {
          logger.error({ err: (err as Error).message, numberId: orphan.id }, 'could not repair missing route');
        }
      }
    }

    // ---------------------------------------------------------------------
    // Check 4: PBX routes that do not exist in our inventory (NEVER auto-removed)
    // ---------------------------------------------------------------------
    const knownPatterns = new Set(
      (await many<{ did_match_pattern: string }>(
        `SELECT did_match_pattern FROM inbound_route_mappings WHERE deleted_at IS NULL AND status <> 'REMOVED'`,
      )).map((r) => r.did_match_pattern),
    );

    for (const route of routes) {
      const pattern = route.extension ?? '';
      if (!pattern) continue; // catch-all "any DID" route: not ours to judge
      if (knownPatterns.has(pattern)) continue;

      await record('WARNING', 'STALE_ROUTE_IN_PBX', `PBX has an inbound route for ${maskNumber(pattern)} that is not in our inventory`, {
        entityType: 'route',
        did: pattern,
        extension: parseExtensionFromDestinationConnection(route.destinationConnection),
        suggestedAction: 'Verify whether this route is managed manually. It will NOT be removed automatically.',
        autoFixable: false,
      });
    }

    // ---------------------------------------------------------------------
    // Housekeeping that makes the system self-healing
    // ---------------------------------------------------------------------
    const recovered = await finaliseStuckAssignments();
    const releasedReservations = await releaseStaleReservations();
    const requeued = await requeueStuckJobs();

    const autoReleaseExpired = await getBool('numbers.auto_release_on_expiry', false);
    const expiry = await expireNumbers({ autoRelease: autoReleaseExpired });

    if (recovered > 0) {
      await record('WARNING', 'STUCK_ASSIGNMENT_RECOVERED', `${recovered} assignment(s) were stuck between PBX success and DB commit and have been completed`, {
        suggestedAction: 'No action required.',
        autoFixable: false,
      });
    }
    if (expiry.flagged > 0 || expiry.released > 0) {
      await record('INFO', 'NUMBERS_EXPIRED', `${expiry.flagged} number(s) flagged as expired, ${expiry.released} released`, {
        suggestedAction: 'Review expired numbers in the inventory screen.',
      });
    }

    const critical = details.filter((d) => d.severity === 'CRITICAL').length;

    await query(
      `UPDATE reconciliation_runs
          SET status = 'COMPLETED', finished_at = now(), extensions_seen = $2, routes_seen = $3,
              findings_count = $4, auto_fixed_count = $5
        WHERE id = $1`,
      [runId, extensions.length, routes.length, details.length, autoFixed],
    );

    await writeAudit({
      actorType: 'WORKER',
      action: 'RECONCILIATION_RUN',
      result: critical > 0 ? 'PARTIAL' : 'SUCCESS',
      targetType: 'system',
      metadata: {
        runId,
        extensions: extensions.length,
        routes: routes.length,
        findings: details.length,
        critical,
        autoFixed,
        recovered,
        releasedReservations,
        requeued,
      },
    });

    if (alert && critical > 0) {
      // DM once per findings-signature (re-bucketed twice a day), not once per
      // run: an unactioned issue should not re-ping the admin every interval,
      // but a NEW signature must always get through.
      const criticalLines = details
        .filter((d) => d.severity === 'CRITICAL')
        .map((d) => `${d.type}:${d.detail}`);
      const signature = createHash('sha1').update(criticalLines.sort().join('|')).digest('hex').slice(0, 16);
      const bucket = Math.floor(Date.now() / (12 * 3_600_000));
      await enqueueAdminNotification(
        'RECONCILIATION_ALERT',
        {
          critical,
          findings: details.filter((d) => d.severity === 'CRITICAL').slice(0, 5),
          runId,
        },
        `recon:${signature}:${bucket}`,
      );
    }

    metrics.gauges.openFindings.set(critical);
    logger.info({ runId, extensions: extensions.length, routes: routes.length, findings: details.length, critical, autoFixed }, 'reconciliation finished');

    return { runId, extensionsSeen: extensions.length, routesSeen: routes.length, findings: details.length, critical, autoFixed, details };
  } catch (err) {
    await query("UPDATE reconciliation_runs SET status = 'FAILED', finished_at = now(), error = $2 WHERE id = $1", [
      runId,
      (err as Error).message,
    ]);
    logger.error({ err: (err as Error).message }, 'reconciliation failed');
    throw err;
  }
}

// -----------------------------------------------------------------------------
// Expiry / reservation housekeeping are exposed for the scheduler
// -----------------------------------------------------------------------------

export async function runHousekeeping(): Promise<void> {
  await releaseStaleReservations();
  await requeueStuckJobs();
  await finaliseStuckAssignments();
}

export async function ensureRouteExistsForNumber(numberId: string): Promise<boolean> {
  const number = await one<{ phone_number: string; sip_extension: string | null; status: string }>(
    'SELECT phone_number, sip_extension, status FROM numbers WHERE id = $1',
    [numberId],
  );
  if (!number?.sip_extension) return false;

  const mapping = await one<{ id: string }>(
    `SELECT id FROM inbound_route_mappings WHERE number_id = $1 AND deleted_at IS NULL AND status = 'ACTIVE'`,
    [numberId],
  );
  if (mapping) return true;

  await applyInboundRoute({
    numberId,
    assignmentId: null,
    didPattern: number.phone_number.replace('+', ''),
    extension: number.sip_extension,
    description: `repair ${new Date().toISOString()}`,
  });
  return true;
}

export async function removeNumberRoute(numberId: string, reason: string): Promise<void> {
  await removeInboundRouteForNumber(numberId, reason);
}

export async function getOpenFindings(limit = 10): Promise<Array<Record<string, unknown>>> {
  return many(
    `SELECT id, severity, finding_type, did, extension, detail, suggested_action, auto_fixable, created_at
       FROM reconciliation_findings WHERE resolved_at IS NULL
      ORDER BY CASE severity WHEN 'CRITICAL' THEN 0 WHEN 'WARNING' THEN 1 ELSE 2 END, created_at DESC
      LIMIT $1`,
    [limit],
  );
}

export async function resolveFinding(findingId: string, actorId: string): Promise<void> {
  await query('UPDATE reconciliation_findings SET resolved_at = now(), resolved_by = $2 WHERE id = $1', [findingId, actorId]);
  await writeAudit({
    actorId,
    actorType: 'ADMIN',
    action: 'RECONCILIATION_FIX_APPLIED',
    targetType: 'system',
    targetId: findingId,
    metadata: { resolved: true },
  });
}

export async function getReconcileIntervalMs(): Promise<number> {
  const minutes = await getNumber('reconcile.interval_minutes', 0);
  if (minutes > 0) return minutes * 60_000;
  return Number(process.env.RECONCILE_INTERVAL_MS ?? 300_000);
}
