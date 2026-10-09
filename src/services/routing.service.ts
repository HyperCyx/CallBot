import { many, one, query } from '../db/pool.js';
import { env } from '../config/env.js';
import { logger, maskNumber } from '../lib/logger.js';
import { getFreePBX } from '../freepbx/index.js';
import { FreePBXGraphQLClient } from '../freepbx/client.js';
import { FreePBXError, type FreePBXInboundRoute } from '../freepbx/types.js';
import { enqueueJob } from './pbxJob.service.js';

/**
 * DID -> SIP routing (spec §13, §15, §17, §31).
 *
 * The routing decision is one line of dialplan, but everything around it is
 * subtle:
 *
 *   DID +971501234567
 *        |
 *        +-- provider trunk --> FreePBX inbound route (extension = DID pattern)
 *                                    |
 *                                    +-- destination: from-did-direct,10194,1
 *                                                |
 *                                                v
 *                                          PJSIP/10194 (user's softphone)
 *
 * WHAT WE STORE
 *   inbound_route_mappings tracks the *intended* state, including the exact
 *   `did_match_pattern` sent to the PBX and the raw destination string. The PBX
 *   returns a human-readable `destinationConnection` ("Extensions: 10194 ..."),
 *   not the raw destination, so drift detection compares the extension part we
 *   can actually observe - and the mapping row keeps the ground truth.
 *
 * WHAT WE NEVER DO
 *   We never edit generated Asterisk config files: the documented
 *   addInboundRoute/updateInboundRoute/removeInboundRoute mutations exist for
 *   exactly this purpose.
 */

export interface RouteMappingRow {
  id: string;
  number_id: string;
  assignment_id: string | null;
  freepbx_route_id: string | null;
  did_match_pattern: string;
  cidnum: string;
  destination: string;
  destination_extension: string | null;
  description: string | null;
  status: 'PENDING' | 'ACTIVE' | 'DISABLED' | 'REMOVED' | 'ERROR';
  last_applied_at: Date | null;
  last_verify_at: Date | null;
  last_error: string | null;
  drift_state: 'OK' | 'MISSING_IN_PBX' | 'MISMATCH' | 'STALE_IN_DB' | null;
  deleted_at: Date | null;
}

/** Builds the FreePBX destination string from the configured template. */
export function buildDestination(extension: string): string {
  const template = env.freepbx.routeDestinationTemplate || 'from-did-direct,{ext},1';
  return template.replace(/\{ext\}/g, extension);
}

/** Parses an extension out of the PBX's human-readable destinationConnection. */
export function parseExtensionFromDestinationConnection(value: string | null | undefined): string | null {
  if (!value) return null;
  // Examples seen in the documented API: "Extensions: 4001 Extension 4001"
  const m = value.match(/(\d{2,11})/);
  return m?.[1] ?? null;
}

export interface ApplyRouteResult {
  mapping: RouteMappingRow;
  pbxWarning?: string;
}

/**
 * Creates (or updates) the inbound route for a number/extension pair.
 *
 * Idempotency: the mapping is written first as PENDING, then applied to the PBX,
 * then flipped to ACTIVE. If the PBX call fails the mapping stays ERROR with the
 * error recorded, and a sync job is queued so the reconciler can converge.
 */
/**
 * FreePBX DIDs are digits only — never a "+", never spaces or brackets
 * (operator rule 2026-10-09: ADD DIDs must be plain numbers). Sanitized once
 * here, at the single chokepoint every route goes through, so no caller can
 * ever leak a "+" DID or "+" description onto the PBX again.
 */
export function sanitizeDid(input: string): string {
  return input.replace(/\D/g, '');
}

export async function applyInboundRoute(input: {
  numberId: string;
  assignmentId: string | null;
  didPattern: string;
  extension: string;
  description?: string;
}): Promise<ApplyRouteResult> {
  const pbx = getFreePBX();
  input = { ...input, didPattern: sanitizeDid(input.didPattern) };
  const destination = buildDestination(input.extension);
  const description = (input.description ?? `sipbot ${input.didPattern} -> ${input.extension}`).replace(/\+/g, '');

  // 1. Upsert the mapping row (intended state).
  const existing = await one<RouteMappingRow>(
    `SELECT * FROM inbound_route_mappings
      WHERE number_id = $1 AND deleted_at IS NULL AND status <> 'REMOVED'
      ORDER BY created_at DESC LIMIT 1`,
    [input.numberId],
  );

  const mapping = existing
    ? await one<RouteMappingRow>(
        `UPDATE inbound_route_mappings
            SET assignment_id = $2, did_match_pattern = $3, destination = $4,
                destination_extension = $5, description = $6, status = 'PENDING', deleted_at = NULL
          WHERE id = $1 RETURNING *`,
        [existing.id, input.assignmentId, input.didPattern, destination, input.extension, description],
      )
    : await one<RouteMappingRow>(
        `INSERT INTO inbound_route_mappings
           (number_id, assignment_id, did_match_pattern, cidnum, destination, destination_extension, description, status)
         VALUES ($1,$2,$3,'',$4,$5,$6,'PENDING') RETURNING *`,
        [input.numberId, input.assignmentId, input.didPattern, destination, input.extension, description],
      );

  if (!mapping) throw new Error('Failed to persist inbound route mapping');

  await enqueueJob({
    jobType: existing ? 'ROUTE_UPDATE' : 'ROUTE_CREATE',
    entityType: 'route',
    entityId: mapping.id,
    idempotencyKey: `route:${input.didPattern}:${input.extension}`,
    payload: { didPattern: input.didPattern, destination, extension: input.extension },
  });

  // 2. Apply to the PBX.
  let pbxWarning: string | undefined;
  try {
    if (existing?.freepbx_route_id && existing.did_match_pattern === input.didPattern) {
      // Identity is "<extension>/<cidnum>"; if the DID changed we must move it.
      const res = await pbx.updateInboundRoute({
        oldExtension: existing.did_match_pattern,
        oldCidnum: existing.cidnum,
        extension: input.didPattern,
        cidnum: '',
        description,
        destination,
      });
      await markApplied(mapping.id, res.routeId);
    } else {
      if (existing?.freepbx_route_id) {
        // The DID itself changed: remove the old route so no stale route remains.
        await safeRemoveRoute(existing.freepbx_route_id);
      }
      const res = await pbx.createInboundRoute({
        extension: input.didPattern,
        cidnum: '',
        description,
        destination,
        ringing: true,
      });
      await markApplied(mapping.id, res.routeId);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // A pre-existing route for this DID pattern means we are out of sync with
    // the PBX: update it instead of failing the whole assignment.
    if (err instanceof FreePBXError && /already exists/i.test(message)) {
      try {
        const res = await pbx.updateInboundRoute({
          oldExtension: input.didPattern,
          oldCidnum: '',
          extension: input.didPattern,
          cidnum: '',
          description,
          destination,
        });
        await markApplied(mapping.id, res.routeId);
        pbxWarning = 'An inbound route for this DID already existed and was re-pointed to the new extension.';
      } catch (updateErr) {
        await markFailed(mapping.id, (updateErr as Error).message);
        throw updateErr;
      }
    } else if (err instanceof FreePBXError && /not found/i.test(message)) {
      // The route we recorded no longer exists on the PBX - it was deleted out
      // of band (FreePBX GUI, another tool, or a restore from backup). This is
      // the *additive* repair path: recreate it and adopt the new route id.
      try {
        const res = await pbx.createInboundRoute({
          extension: input.didPattern,
          cidnum: '',
          description,
          destination,
          ringing: true,
        });
        await markApplied(mapping.id, res.routeId);
        pbxWarning = 'The recorded inbound route had been deleted on the PBX and was recreated.';
      } catch (createErr) {
        await markFailed(mapping.id, (createErr as Error).message);
        throw createErr;
      }
    } else {
      await markFailed(mapping.id, message);
      throw err;
    }
  }

  const fresh = await one<RouteMappingRow>('SELECT * FROM inbound_route_mappings WHERE id = $1', [mapping.id]);
  logger.info(
    { did: maskNumber(input.didPattern), extension: input.extension, routeId: fresh?.freepbx_route_id },
    'inbound route applied',
  );
  return { mapping: fresh!, ...(pbxWarning ? { pbxWarning } : {}) };
}

async function markApplied(mappingId: string, routeId: string): Promise<void> {
  await query(
    `UPDATE inbound_route_mappings
        SET freepbx_route_id = $2, status = 'ACTIVE', last_applied_at = now(), last_error = NULL, drift_state = 'OK'
      WHERE id = $1`,
    [mappingId, routeId],
  );
  await query('UPDATE numbers SET last_route_sync_at = now() WHERE id = (SELECT number_id FROM inbound_route_mappings WHERE id = $1)', [
    mappingId,
  ]);
}

async function markFailed(mappingId: string, error: string): Promise<void> {
  await query(
    `UPDATE inbound_route_mappings SET status = 'ERROR', last_error = $2 WHERE id = $1`,
    [mappingId, error.slice(0, 500)],
  );
}

async function safeRemoveRoute(routeId: string): Promise<void> {
  try {
    await getFreePBX().deleteInboundRoute(routeId);
  } catch (err) {
    if (err instanceof FreePBXError && err.kind === 'NOT_FOUND') return;
    logger.warn({ routeId, err: (err as Error).message }, 'could not remove old inbound route; queued for reconciliation');
    await enqueueJob({
      jobType: 'ROUTE_DELETE',
      entityType: 'route',
      idempotencyKey: `route-delete:${routeId}:${Date.now()}`,
      payload: { routeId },
    });
  }
}

/**
 * Removes the inbound route for a number (release / delete / suspension policy).
 * The mapping row is kept with status REMOVED so the history of what existed
 * when stays auditable.
 */
export async function removeInboundRouteForNumber(numberId: string, reason: string): Promise<void> {
  const mapping = await one<RouteMappingRow>(
    `SELECT * FROM inbound_route_mappings
      WHERE number_id = $1 AND deleted_at IS NULL AND status <> 'REMOVED'
      ORDER BY created_at DESC LIMIT 1`,
    [numberId],
  );
  if (!mapping) return;

  if (mapping.freepbx_route_id) {
    await safeRemoveRoute(mapping.freepbx_route_id);
  }

  await query(
    `UPDATE inbound_route_mappings
        SET status = 'REMOVED', deleted_at = now(), last_error = $2
      WHERE id = $1`,
    [mapping.id, reason],
  );
}

/** Re-points an existing route at a different extension (reassignment, §15). */
export async function repointRoute(numberId: string, newExtension: string, opts: { assignmentId?: string | null } = {}): Promise<ApplyRouteResult> {
  const mapping = await one<RouteMappingRow>(
    `SELECT * FROM inbound_route_mappings
      WHERE number_id = $1 AND deleted_at IS NULL AND status <> 'REMOVED'
      ORDER BY created_at DESC LIMIT 1`,
    [numberId],
  );
  if (!mapping) throw new Error('No inbound route mapping exists for this number');

  return applyInboundRoute({
    numberId,
    assignmentId: opts.assignmentId ?? mapping.assignment_id,
    didPattern: mapping.did_match_pattern,
    extension: newExtension,
    description: `sipbot ${mapping.did_match_pattern} -> ${newExtension}`,
  });
}

/** Verifies a single mapping against the PBX (used by the reconciler). */
export async function verifyRouteMapping(mapping: RouteMappingRow, opts: { routeIndex?: Map<string, FreePBXInboundRoute> } = {}): Promise<{
  state: 'OK' | 'MISSING_IN_PBX' | 'MISMATCH' | 'UNAVAILABLE';
  detail: string;
  observed?: FreePBXInboundRoute | null;
}> {
  const pbx = getFreePBX();
  if (!mapping.freepbx_route_id) {
    return { state: 'MISSING_IN_PBX', detail: 'No FreePBX route id recorded for this mapping' };
  }

  // READ STRATEGY (verified on the live PBX, 2026-10-08)
  // ---------------------------------------------------
  // Never judge existence from the by-id query: this Sangoma build answers
  // `inboundRoute(id:)` for a deleted route with a GraphQL "Internal server
  // error" instead of null. Interpreting a server error as "route is gone"
  // nearly caused the reconciler to mis-detect (and with auto-fix, recreate)
  // live routes, and it killed every run with a ❌ alert. The list query
  // (`allInboundRoutes`) works fine even when by-id reads crash, so route
  // existence is decided by LIST MEMBERSHIP; the by-id read is only a
  // fallback, and a generic failure there yields UNAVAILABLE - "we do not
  // know" is reported, never guessed.
  let observed: FreePBXInboundRoute | null = null;
  if (opts.routeIndex) {
    observed = opts.routeIndex.get(mapping.freepbx_route_id) ?? null;
  } else {
    try {
      const routes = await pbx.getAllInboundRoutes();
      observed = routes.find((r) => r.id === mapping.freepbx_route_id) ?? null;
    } catch (listErr) {
      logger.warn({ err: (listErr as Error).message }, 'route list read failed; falling back to the by-id query');
      try {
        observed = await pbx.getInboundRoute(mapping.freepbx_route_id);
      } catch (err) {
        if (FreePBXGraphQLClient.isNotFoundText(err)) {
          observed = null;
        } else {
          return {
            state: 'UNAVAILABLE',
            detail: `PBX could not answer route reads right now: ${(err as Error).message}. Nothing was changed; the next run retries.`,
          };
        }
      }
    }
  }

  await query('UPDATE inbound_route_mappings SET last_verify_at = now() WHERE id = $1', [mapping.id]);

  if (!observed) {
    return { state: 'MISSING_IN_PBX', detail: `Route ${mapping.freepbx_route_id} does not exist on the PBX` };
  }

  const observedExt = parseExtensionFromDestinationConnection(observed.destinationConnection);
  if (observedExt && mapping.destination_extension && observedExt !== mapping.destination_extension) {
    return {
      state: 'MISMATCH',
      detail: `Route points at extension ${observedExt} but should point at ${mapping.destination_extension}`,
      observed,
    };
  }
  return { state: 'OK', detail: 'Route matches the database', observed };
}

/**
 * All routes that point at an extension, from the DB. Used when disabling or
 * enabling the routes of a suspended number (§16).
 */
export async function listMappingsForUser(userId: string): Promise<RouteMappingRow[]> {
  return many<RouteMappingRow>(
    `SELECT m.* FROM inbound_route_mappings m
       JOIN numbers n ON n.id = m.number_id
      WHERE n.assigned_user_id = $1 AND m.deleted_at IS NULL AND m.status <> 'REMOVED'`,
    [userId],
  );
}
