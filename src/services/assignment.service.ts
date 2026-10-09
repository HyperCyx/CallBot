import type { DbClient } from '../db/pool.js';
import { many, one, query, withTransaction } from '../db/pool.js';
import { AppError, conflict, forbidden, notFound } from '../lib/errors.js';
import { logger, maskNumber } from '../lib/logger.js';
import { metrics } from '../lib/metrics.js';
import { getFreePBX } from '../freepbx/index.js';
import { FreePBXError } from '../freepbx/types.js';
import { writeAudit } from './audit.service.js';
import { effectivePriceForOffer } from './catalog.service.js';
import { debitWallet } from './wallet.service.js';
import { checkPlanAllowsNumber } from './catalog.service.js';
import { applyInboundRoute, removeInboundRouteForNumber, repointRoute } from './routing.service.js';
import { getSipAccountByUser } from './extension.service.js';
import { countNumbersForUser } from './inventory.service.js';
import { enqueueJob } from './pbxJob.service.js';
import { getUserById } from './user.service.js';

/**
 * ATOMIC NUMBER ASSIGNMENT (spec §12, §14, §15, §16, §36, §39)
 * ============================================================
 *
 * The exact sequence required by the specification, and how it is implemented:
 *
 *   BEGIN
 *   1. Lock available number      -> SELECT ... FOR UPDATE SKIP LOCKED
 *   2. Verify status=AVAILABLE    -> same query's WHERE clause + a re-check
 *                                    inside the transaction
 *   3. Verify user is active      -> SELECT ... FOR UPDATE on the user row
 *   4. Verify plan permits it     -> checkPlanAllowsNumber() + in-transaction
 *                                    re-count of the user's numbers
 *   5. Mark number RESERVED       -> status + reservation_expires_at
 *   6. Configure FreePBX route    -> OUTSIDE the transaction (network I/O must
 *                                    not hold row locks), protected by a
 *                                    durable sync job
 *   7. Verify FreePBX response    -> the mutation returns status/message and
 *                                    the resulting route id
 *   8. Mark number ASSIGNED       -> second, short transaction
 *   9. COMMIT
 *
 *   If FreePBX fails -> the reservation is rolled back, the number returns to
 *   AVAILABLE and the user is told nothing was assigned (never "assigned" then
 *   a silent failure).
 *
 * If FreePBX succeeds but the second transaction fails (process crash), the
 * assignment row stays in RESERVING with the route id recorded, and the
 * reconciliation worker converges it: the DID/extension pair is already known,
 * so nothing is lost and no duplicate route can be created (the mapping is
 * unique per DID pattern).
 */

const RESERVATION_TTL_MINUTES = 10;

export interface AssignOptions {
  userId: string;
  countryId?: string | null;
  serviceId?: string | null;
  /** Ask for premium inventory explicitly; the plan check still applies. */
  planType?: 'FREE' | 'PREMIUM';
  /** Restrict to one specific number (admin assignment / reassignment). */
  numberId?: string;
  /**
   * "Taking another number": when the plan's allowance is already used up,
   * assign the new number first and then automatically release the oldest one
   * the user holds - no manual release step. The old number is only released
   * after the new assignment succeeded, so a failed assignment can never cost
   * the user the number they already had.
   */
  replaceOldest?: boolean;
  source?: 'USER' | 'ADMIN' | 'API';
  actorId?: string | null;
  actorTelegramId?: number | null;
  requestId?: string | null;
}

export interface AssignmentResult {
  numberId: string;
  phoneNumber: string;
  extension: string;
  routeId: string | null;
  assignmentId: string;
  expiresAt: Date | null;
  /** Present when the number was paid for (wallet was charged `chargedCents`). */
  chargedCents?: number;
  chargedCurrency?: string;
  /** Wallet balance right after the charge (only when charged). */
  balanceAfterCents?: number;
  pbxWarning?: string;
  /** Numbers that were replaced automatically because the plan was full. */
  replacedNumbers?: string[];
}

export interface AssignmentRow {
  id: string;
  number_id: string;
  user_id: string;
  sip_account_id: string | null;
  sip_extension: string | null;
  status: 'RESERVING' | 'ACTIVE' | 'SUSPENDED' | 'RELEASED' | 'FAILED';
  assigned_at: Date;
  released_at: Date | null;
  release_reason: string | null;
  freepbx_route_id: string | null;
  expires_at: Date | null;
  failure_reason: string | null;
}

// -----------------------------------------------------------------------------
// Assignment
// -----------------------------------------------------------------------------

export async function assignNumber(opts: AssignOptions): Promise<AssignmentResult> {
  const source = opts.source ?? 'USER';
  let attemptNumberId: string | null = null;

  try {
    // ---------------- transaction 1: reserve -------------------------------
    const reserved = await withTransaction(
      async (client) => {
        // 3. Verify the user (and lock them: this serialises two concurrent
        //    taps from the same user so the plan limit cannot be exceeded).
        const userRes = await client.query<{ id: string; status: string; plan_id: string | null; expires_at: Date | null }>(
          'SELECT id, status, plan_id, expires_at FROM users WHERE id = $1 AND deleted_at IS NULL FOR UPDATE',
          [opts.userId],
        );
        const user = userRes.rows[0];
        if (!user) throw notFound('User');
        if (user.status !== 'ACTIVE') throw new AppError('ACCOUNT_NOT_ACTIVE', 'Your account is not active. Please contact support.');
        if (user.expires_at && user.expires_at.getTime() < Date.now()) {
          throw new AppError('ACCOUNT_NOT_ACTIVE', 'Your subscription has expired.');
        }

        const sip = await getSipAccountByUser(opts.userId);
        if (!sip || sip.status !== 'ACTIVE') {
          throw new AppError('ACCOUNT_NOT_ACTIVE', 'Your SIP account is not ready yet. Please contact support.');
        }

        // 1 + 2. Pick and lock a free number. SKIP LOCKED means concurrent
        //        assignments never contend: each takes a DIFFERENT row.
        const candidate = await lockFreeNumber(client, opts);
        if (!candidate) {
          throw new AppError(
            'NO_INVENTORY',
            opts.planType === 'PREMIUM'
              ? 'No premium numbers are available right now. Please try again later.'
              : 'No numbers are available for this selection right now. Please try again later.',
          );
        }
        attemptNumberId = candidate.id;

        // 1b. Wallet charge (paid numbers; operator decision 2026-10-08).
        //     The debit lives INSIDE this transaction: not enough balance →
        //     InsufficientFundsError aborts before anything is reserved, and a
        //     crash here touches no balance, no inventory, no PBX. If the PBX
        //     step fails after commit, rollbackReservation() refunds exactly
        //     what was charged. The number-level price overrides the country
        //     offer price; no offer row at all means the number is free.
        const price = await effectivePriceForOffer(
          { numberId: candidate.id, countryId: candidate.country_id, serviceId: candidate.service_id },
          client,
        );
        let charge: { cents: number; currency: string; balanceAfterCents: number } | null = null;
        if (price.cents && price.cents > 0) {
          const ledger = await debitWallet(opts.userId, price.cents, {
            reference: `purchase:number:${candidate.id}`,
            actorType: source === 'ADMIN' ? 'ADMIN' : 'USER',
            actorId: opts.actorId ?? opts.userId,
            metadata: { countryId: candidate.country_id, serviceId: candidate.service_id, phoneNumber: candidate.phone_number },
            client,
          });
          charge = { cents: price.cents, currency: price.currency, balanceAfterCents: ledger.balance_after_cents };
        }

        // 4. Plan rules: in-transaction recount so two concurrent requests
        //    cannot each "see" a free slot.
        const currentCountRes = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM numbers
            WHERE assigned_user_id = $1 AND deleted_at IS NULL AND status IN ('ASSIGNED','SUSPENDED','RESERVED')`,
          [opts.userId],
        );
        const currentCount = Number(currentCountRes.rows[0]?.count ?? 0);
        const planCheck = await checkPlanAllowsNumber({
          planId: user.plan_id,
          userId: opts.userId,
          countryId: candidate.country_id,
          serviceId: candidate.service_id,
          planType: candidate.plan_type,
          currentCount,
        });

        // "Taking another number" with a full allowance: the oldest numbers the
        // user holds are marked here and released AFTER this assignment
        // succeeds (the release does PBX I/O, and a failed assignment must
        // never cost the user the number they already had).
        const toRelease: Array<{ id: string; phone_number: string }> = [];
        if (!planCheck.allowed && planCheck.code === 'PLAN_LIMIT' && opts.replaceOldest) {
          const limit = planCheck.limit ?? 1;
          const need = Math.max(1, currentCount - limit + 1);
          const oldest = await client.query<{ id: string; phone_number: string }>(
            `SELECT id, phone_number FROM numbers
              WHERE assigned_user_id = $1 AND deleted_at IS NULL AND status IN ('ASSIGNED','SUSPENDED')
              ORDER BY assigned_at ASC NULLS LAST, created_at ASC
              LIMIT $2 FOR UPDATE`,
            [opts.userId, need],
          );
          if (oldest.rows.length < need) {
            // Everything else is mid-flight (reserved): fail closed rather than
            // leave the account over its allowance.
            throw new AppError('PLAN_LIMIT', planCheck.reason ?? 'Your plan does not allow this number.');
          }
          toRelease.push(...oldest.rows);
        } else if (!planCheck.allowed) {
          throw new AppError(planCheck.code === 'PLAN_LIMIT' ? 'PLAN_LIMIT' : 'FORBIDDEN', planCheck.reason ?? 'Your plan does not allow this number.');
        }

        // 5. Reserve.
        await client.query(
          `UPDATE numbers
              SET status = 'RESERVED', reserved_at = now(), reserved_by = $2,
                  reservation_expires_at = now() + ($3 || ' minutes')::interval, status_reason = 'assignment in progress'
            WHERE id = $1`,
          [candidate.id, opts.userId, String(RESERVATION_TTL_MINUTES)],
        );

        const assignmentRes = await client.query<AssignmentRow>(
          `INSERT INTO number_assignments
             (number_id, user_id, sip_account_id, sip_extension, assigned_by, assignment_source, status,
              plan_id, plan_type, price_cents, currency, expires_at)
           VALUES ($1,$2,$3,$4,$5,$6,'RESERVING',$7,$8,$9,$10,$11)
           RETURNING *`,
          [
            candidate.id,
            opts.userId,
            sip.id,
            sip.extension,
            opts.actorId ?? null,
            source,
            user.plan_id,
            candidate.plan_type,
            candidate.price_cents,
            candidate.currency,
            null,
          ],
        );

        return { candidate, assignment: assignmentRes.rows[0]!, sip, toRelease, charge };
      },
      // READ COMMITTED: SELECT ... FOR UPDATE SKIP LOCKED plus the FOR UPDATE
      // lock on the user row are the real guarantees; each statement must see
      // the latest committed state so the plan recount is accurate.
      { isolation: 'READ COMMITTED', lockTimeoutMs: 5_000 },
    );

    const { candidate, assignment, sip, toRelease, charge } = reserved;

    // ---------------- step 6/7: configure the PBX route --------------------
    let routeId: string | null = null;
    let pbxWarning: string | undefined;
    try {
      const applied = await applyInboundRoute({
        numberId: candidate.id,
        assignmentId: assignment.id,
        didPattern: candidate.did_match_pattern ?? candidate.phone_number.replace('+', ''),
        extension: sip.extension,
        description: `${source.toLowerCase()} ${candidate.phone_number} -> ${sip.extension}`,
      });
      routeId = applied.mapping.freepbx_route_id;
      pbxWarning = applied.pbxWarning;
    } catch (err) {
      // Roll back the reservation: the number stays AVAILABLE (spec §36), and
      // whatever the wallet was charged comes back in the same atomic move.
      await rollbackReservation(candidate.id, assignment.id, err, charge);
      metrics.counters.assignmentFailures.inc(1, { reason: 'pbx' });
      throw toAssignmentError(err);
    }

    // ---------------- step 8: commit the assignment ------------------------
    const finalised = await withTransaction(async (client) => {
      await client.query(
        `UPDATE numbers
            SET status = 'ASSIGNED', assigned_user_id = $2, assigned_at = now(), sip_extension = $3,
                reserved_at = NULL, reserved_by = NULL, reservation_expires_at = NULL, status_reason = NULL
          WHERE id = $1 AND status = 'RESERVED'`,
        [candidate.id, opts.userId, sip.extension],
      );

      const updated = await client.query<AssignmentRow>(
        `UPDATE number_assignments
            SET status = 'ACTIVE', freepbx_route_id = $2, route_synced_at = now()
          WHERE id = $1 RETURNING *`,
        [assignment.id, routeId],
      );

      await writeAudit({
        client,
        actorId: opts.actorId ?? opts.userId,
        actorTelegramId: opts.actorTelegramId ?? null,
        actorType: source === 'ADMIN' ? 'ADMIN' : 'USER',
        action: 'NUMBER_ASSIGNED',
        targetType: 'number',
        targetId: candidate.id,
        targetRef: maskNumber(candidate.phone_number),
        metadata: {
          userId: opts.userId,
          extension: sip.extension,
          freepbxRouteId: routeId,
          freepbxResult: 'SUCCESS',
          planType: candidate.plan_type,
          source,
        },
        requestId: opts.requestId ?? null,
      });

      return updated.rows[0]!;
    });

    metrics.counters.assignments.inc(1, { planType: candidate.plan_type });
    logger.info(
      { did: maskNumber(candidate.phone_number), extension: sip.extension, userId: opts.userId, source },
      'number assigned',
    );

    // The new number is live - now the replaced one(s) go back to inventory.
    // A failure here leaves the old number attached until the next attempt (it
    // is never lost), so it is reported, not thrown.
    const replacedNumbers: string[] = [];
    for (const old of toRelease) {
      try {
        await releaseNumber(old.id, {
          actorId: opts.actorId ?? opts.userId,
          actorTelegramId: opts.actorTelegramId ?? null,
          actorType: source === 'ADMIN' ? 'ADMIN' : 'USER',
          reason: 'replaced by a new number',
          resultingStatus: 'AVAILABLE',
          requestId: opts.requestId ?? null,
        });
        replacedNumbers.push(old.phone_number);
      } catch (err) {
        logger.warn(
          { did: maskNumber(old.phone_number), userId: opts.userId, err: (err as Error).message },
          'could not release the replaced number; it is still attached to the user',
        );
      }
    }

    return {
      numberId: candidate.id,
      phoneNumber: candidate.phone_number,
      extension: sip.extension,
      routeId,
      assignmentId: finalised.id,
      expiresAt: finalised.expires_at,
      ...(charge ? { chargedCents: charge.cents, chargedCurrency: charge.currency, balanceAfterCents: charge.balanceAfterCents } : {}),
      ...(pbxWarning ? { pbxWarning } : {}),
      ...(replacedNumbers.length > 0 ? { replacedNumbers } : {}),
    };
  } catch (err) {
    // Defensive: if we crashed after reserving but before finalising, make sure
    // the number does not stay RESERVED. The sweeper also handles this.
    if (attemptNumberId) {
      await releaseIfStillReserved(attemptNumberId, opts.userId).catch(() => undefined);
    }
    throw err;
  }
}

interface CandidateNumber {
  id: string;
  phone_number: string;
  did_match_pattern: string | null;
  country_id: string;
  service_id: string;
  plan_type: 'FREE' | 'PREMIUM';
  price_cents: number | null;
  currency: string;
}

/** Locks (FOR UPDATE SKIP LOCKED) the best available number for the request. */
async function lockFreeNumber(client: DbClient, opts: AssignOptions): Promise<CandidateNumber | null> {
  const params: unknown[] = [];
  const conditions = [
    "n.status = 'AVAILABLE'",
    'n.deleted_at IS NULL',
    '(n.expiration_date IS NULL OR n.expiration_date >= current_date)',
  ];

  if (opts.numberId) {
    params.push(opts.numberId);
    conditions.push(`n.id = $${params.length}`);
  }
  if (opts.countryId) {
    params.push(opts.countryId);
    conditions.push(`n.country_id = $${params.length}`);
  }
  if (opts.serviceId) {
    params.push(opts.serviceId);
    conditions.push(`n.service_id = $${params.length}`);
  }
  if (opts.planType) {
    params.push(opts.planType);
    conditions.push(`n.plan_type = $${params.length}`);
  }

  const res = await client.query<CandidateNumber>(
    `SELECT n.id, n.phone_number, n.did_match_pattern, n.country_id, n.service_id, n.plan_type, n.price_cents, n.currency
       FROM numbers n
       JOIN services s ON s.id = n.service_id AND s.status = 'ACTIVE' AND s.deleted_at IS NULL
       JOIN countries c ON c.id = n.country_id AND c.status = 'ACTIVE' AND c.deleted_at IS NULL
      WHERE ${conditions.join(' AND ')}
      ORDER BY n.created_at ASC
      LIMIT 1
      FOR UPDATE OF n SKIP LOCKED`,
    params,
  );
  return res.rows[0] ?? null;
}

async function rollbackReservation(
  numberId: string,
  assignmentId: string,
  err: unknown,
  charge: { cents: number; currency: string; balanceAfterCents: number } | null = null,
): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  await withTransaction(async (client) => {
    if (charge && charge.cents > 0) {
      // Exact reversal of the in-transaction debit; the purchase can never
      // stick to a failed deployment.
      const assignment = await client.query<{ user_id: string }>('SELECT user_id FROM number_assignments WHERE id = $1', [assignmentId]);
      const owner = assignment.rows[0]?.user_id;
      if (owner) {
        const { refundWallet } = await import('./wallet.service.js');
        await refundWallet(owner, charge.cents, {
          reference: `refund:number:${numberId}`,
          actorType: 'SYSTEM',
          metadata: { reason: 'assignment failed after charge', originalError: message.slice(0, 300) },
          client,
        });
      }
    }
    await client.query(
      `UPDATE numbers SET status = 'AVAILABLE', reserved_at = NULL, reserved_by = NULL,
              reservation_expires_at = NULL, status_reason = 'assignment failed'
        WHERE id = $1 AND status = 'RESERVED'`,
      [numberId],
    );
    await client.query(
      `UPDATE number_assignments SET status = 'FAILED', released_at = now(), failure_reason = $2 WHERE id = $1`,
      [assignmentId, message.slice(0, 500)],
    );
    await writeAudit({
      client,
      actorType: 'SYSTEM',
      action: 'NUMBER_ASSIGNMENT_FAILED',
      result: 'FAILURE',
      targetType: 'number',
      targetId: numberId,
      reason: message.slice(0, 500),
      metadata: { freebxResult: 'FAILURE', rolledBack: true },
    });
  });
}

async function releaseIfStillReserved(numberId: string, userId: string): Promise<void> {
  await query(
    `UPDATE numbers SET status = 'AVAILABLE', reserved_at = NULL, reserved_by = NULL,
            reservation_expires_at = NULL, status_reason = 'assignment aborted'
      WHERE id = $1 AND status = 'RESERVED' AND reserved_by = $2`,
    [numberId, userId],
  );
}

function toAssignmentError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof FreePBXError) {
    return new AppError(
      err.kind === 'REJECTED' ? 'PBX_REJECTED' : 'PBX_UNAVAILABLE',
      '❌ The number could not be assigned because the PBX returned an error. Nothing was assigned - the number is still available. Please try again in a moment.',
      { cause: err, details: { pbxKind: err.kind } },
    );
  }
  return new AppError('INTERNAL', 'The number could not be assigned. The incident was logged and the number is still available.', { cause: err });
}

// -----------------------------------------------------------------------------
// Release
// -----------------------------------------------------------------------------

export async function releaseNumber(
  numberId: string,
  opts: {
    actorId: string;
    actorTelegramId?: number | null;
    actorType?: 'USER' | 'ADMIN';
    reason?: string;
    /** AVAILABLE returns it to inventory; DISABLED retires it (§17). */
    resultingStatus?: 'AVAILABLE' | 'DISABLED';
    requestId?: string | null;
  },
): Promise<void> {
  const number = await one<{ id: string; phone_number: string; assigned_user_id: string | null; status: string }>(
    'SELECT id, phone_number, assigned_user_id, status FROM numbers WHERE id = $1 AND deleted_at IS NULL',
    [numberId],
  );
  if (!number) throw notFound('Number');

  const activeAssignment = await one<AssignmentRow>(
    'SELECT * FROM number_assignments WHERE number_id = $1 AND released_at IS NULL ORDER BY assigned_at DESC LIMIT 1',
    [numberId],
  );

  // 1. Remove the DID route FIRST: a route pointing at an extension that no
  //    longer owns the number is the worst possible intermediate state.
  await removeInboundRouteForNumber(numberId, opts.reason ?? 'released');

  // 2. Close the assignment + free the inventory row atomically.
  await withTransaction(async (client) => {
    if (activeAssignment) {
      await client.query(
        `UPDATE number_assignments
            SET status = 'RELEASED', released_at = now(), released_by = $2, release_reason = $3
          WHERE id = $1`,
        [activeAssignment.id, opts.actorId, opts.reason ?? 'released'],
      );
    }
    await client.query(
      `UPDATE numbers SET status = $2, assigned_user_id = NULL, assigned_at = NULL, sip_extension = NULL,
              reserved_at = NULL, reserved_by = NULL, reservation_expires_at = NULL, status_reason = $3
        WHERE id = $1`,
      [numberId, opts.resultingStatus ?? 'AVAILABLE', opts.reason ?? 'released'],
    );

    await writeAudit({
      client,
      actorId: opts.actorId,
      actorTelegramId: opts.actorTelegramId ?? null,
      actorType: opts.actorType ?? 'ADMIN',
      action: 'NUMBER_RELEASED',
      targetType: 'number',
      targetId: numberId,
      targetRef: maskNumber(number.phone_number),
      metadata: { previousUserId: number.assigned_user_id, previousStatus: number.status, reason: opts.reason ?? null },
      requestId: opts.requestId ?? null,
    });
  });

  metrics.counters.releases.inc(1);
  logger.info({ did: maskNumber(number.phone_number), reason: opts.reason }, 'number released');
}

// -----------------------------------------------------------------------------
// Suspend / unsuspend
// -----------------------------------------------------------------------------

/**
 * Suspends a number (spec §16).
 *
 * Chosen FreePBX design: the inbound route is REMOVED rather than re-pointed to
 * a "number suspended" announcement, because that is the documented-safe
 * operation with no extra dialplan objects to manage. The number stays in
 * inventory, still linked to its holder, and the user is told it is suspended.
 * Swapping in an announcement destination later only requires changing the
 * route destination string here.
 */
export async function suspendNumber(
  numberId: string,
  opts: { actorId: string; reason?: string; requestId?: string | null },
): Promise<void> {
  const number = await one<{ id: string; phone_number: string; assigned_user_id: string | null; status: string }>(
    'SELECT * FROM numbers WHERE id = $1 AND deleted_at IS NULL',
    [numberId],
  );
  if (!number) throw notFound('Number');
  if (number.status === 'SUSPENDED') throw conflict('This number is already suspended.');
  if (!number.assigned_user_id) throw conflict('Only an assigned number can be suspended.');

  await removeInboundRouteForNumber(numberId, 'suspended');

  await withTransaction(async (client) => {
    await client.query("UPDATE numbers SET status = 'SUSPENDED', status_reason = $2 WHERE id = $1", [numberId, opts.reason ?? 'suspended by admin']);
    await client.query(
      `UPDATE number_assignments SET status = 'SUSPENDED' WHERE number_id = $1 AND released_at IS NULL`,
      [numberId],
    );
    await writeAudit({
      client,
      actorId: opts.actorId,
      actorType: 'ADMIN',
      action: 'NUMBER_SUSPENDED',
      targetType: 'number',
      targetId: numberId,
      targetRef: maskNumber(number.phone_number),
      reason: opts.reason ?? null,
      metadata: { previousUserId: number.assigned_user_id, routeRemoved: true },
      requestId: opts.requestId ?? null,
    });
  });
}

export async function unsuspendNumber(numberId: string, opts: { actorId: string; requestId?: string | null }): Promise<void> {
  const number = await one<{ id: string; phone_number: string; assigned_user_id: string | null; status: string; sip_extension: string | null }>(
    'SELECT * FROM numbers WHERE id = $1 AND deleted_at IS NULL',
    [numberId],
  );
  if (!number) throw notFound('Number');
  if (number.status !== 'SUSPENDED') throw conflict('This number is not suspended.');
  if (!number.assigned_user_id || !number.sip_extension) throw conflict('The number has no active owner to re-point the route at.');

  const sip = await getSipAccountByUser(number.assigned_user_id);
  const extension = sip?.status === 'ACTIVE' ? sip.extension : number.sip_extension;

  // Suspension REMOVED the mapping, so recreate it (applyInboundRoute upserts the
  // mapping and re-applies the route on the PBX).
  const numberRow = await one<{ did_match_pattern: string | null; phone_number: string }>(
    'SELECT did_match_pattern, phone_number FROM numbers WHERE id = $1',
    [numberId],
  );
  await applyInboundRoute({
    numberId,
    assignmentId: null,
    didPattern: numberRow?.did_match_pattern ?? (numberRow?.phone_number ?? '').replace('+', ''),
    extension,
    description: `unsuspended ${new Date().toISOString()}`,
  });

  await withTransaction(async (client) => {
    await client.query("UPDATE numbers SET status = 'ASSIGNED', status_reason = NULL WHERE id = $1", [numberId]);
    await client.query(`UPDATE number_assignments SET status = 'ACTIVE' WHERE number_id = $1 AND released_at IS NULL`, [numberId]);
    await writeAudit({
      client,
      actorId: opts.actorId,
      actorType: 'ADMIN',
      action: 'NUMBER_UNSUSPENDED',
      targetType: 'number',
      targetId: numberId,
      targetRef: maskNumber(number.phone_number),
      metadata: { extension },
      requestId: opts.requestId ?? null,
    });
  });
}

// -----------------------------------------------------------------------------
// Reassignment (spec §15)
// -----------------------------------------------------------------------------

/**
 * Moves a number from its current holder to another user WITHOUT ever leaving a
 * stale inbound route:
 *
 *   release old holder (route removed) -> assign to new user (route created)
 *
 * If the second half fails, the number ends up AVAILABLE - which is the safe,
 * visible state - and the failure is audited.
 */
export async function reassignNumber(
  numberId: string,
  toUserId: string,
  opts: { actorId: string; actorTelegramId?: number | null; reason?: string; requestId?: string | null },
): Promise<AssignmentResult> {
  const number = await one<{ id: string; phone_number: string; assigned_user_id: string | null }>(
    'SELECT * FROM numbers WHERE id = $1 AND deleted_at IS NULL',
    [numberId],
  );
  if (!number) throw notFound('Number');

  const target = await getUserById(toUserId);
  if (!target) throw notFound('Target user');
  if (target.status !== 'ACTIVE') throw conflict('The target user is not active.');
  if (target.id === number.assigned_user_id) throw conflict('The number is already assigned to that user.');

  if (number.assigned_user_id) {
    await releaseNumber(numberId, {
      actorId: opts.actorId,
      actorType: 'ADMIN',
      reason: `reassignment to ${toUserId}`,
      resultingStatus: 'AVAILABLE',
      requestId: opts.requestId ?? null,
    });
  }

  const result = await assignNumber({
    userId: toUserId,
    numberId,
    source: 'ADMIN',
    actorId: opts.actorId,
    ...(opts.actorTelegramId !== undefined ? { actorTelegramId: opts.actorTelegramId } : {}),
    requestId: opts.requestId ?? null,
  });

  await writeAudit({
    actorId: opts.actorId,
    actorTelegramId: opts.actorTelegramId ?? null,
    actorType: 'ADMIN',
    action: 'NUMBER_REASSIGNED',
    targetType: 'number',
    targetId: numberId,
    targetRef: maskNumber(number.phone_number),
    metadata: { fromUserId: number.assigned_user_id, toUserId, extension: result.extension },
    requestId: opts.requestId ?? null,
  });

  return result;
}

// -----------------------------------------------------------------------------
// Expiry (spec §32)
// -----------------------------------------------------------------------------

/**
 * Marks numbers whose expiration_date has passed. The configured policy decides
 * whether they are suspended immediately; the default is to flag them and let
 * an admin decide, because releasing a DID can be commercially irreversible.
 */
export async function expireNumbers(opts: { autoRelease: boolean }): Promise<{ flagged: number; released: number }> {
  const expired = await many<{ id: string; phone_number: string; assigned_user_id: string | null }>(
    `SELECT id, phone_number, assigned_user_id FROM numbers
      WHERE expiration_date IS NOT NULL AND expiration_date < current_date
        AND status IN ('ASSIGNED','SUSPENDED') AND deleted_at IS NULL`,
  );

  let flagged = 0;
  let released = 0;
  for (const number of expired) {
    if (opts.autoRelease) {
      await releaseNumber(number.id, {
        actorId: number.assigned_user_id ?? 'system',
        actorType: 'ADMIN',
        reason: 'expired',
        resultingStatus: 'AVAILABLE',
      });
      released += 1;
    } else {
      await query(
        `UPDATE numbers SET status = 'EXPIRED', status_reason = 'expiration date passed' WHERE id = $1`,
        [number.id],
      );
      await writeAudit({
        actorType: 'WORKER',
        action: 'NUMBER_SUSPENDED',
        targetType: 'number',
        targetId: number.id,
        targetRef: maskNumber(number.phone_number),
        reason: 'expired (flagged for admin review)',
        metadata: { automatic: true },
      });
      flagged += 1;
    }
  }
  return { flagged, released };
}

/** Numbers a user holds, for their own "My Numbers" screen. */
export async function listUserAssignments(userId: string): Promise<number> {
  return countNumbersForUser(userId);
}

/**
 * Safety net for "PBX succeeded, DB update failed": finds assignments stuck in
 * RESERVING with a healthy route, and completes them. Called by the reconciler.
 */
export async function finaliseStuckAssignments(): Promise<number> {
  const stuck = await many<AssignmentRow & { phone_number: string }>(
    `SELECT a.*, n.phone_number FROM number_assignments a
       JOIN numbers n ON n.id = a.number_id
      WHERE a.status = 'RESERVING' AND a.assigned_at < now() - interval '2 minutes'`,
  );

  let fixed = 0;
  for (const row of stuck) {
    const mapping = await one<{ freepbx_route_id: string | null; status: string }>(
      `SELECT freepbx_route_id, status FROM inbound_route_mappings
        WHERE assignment_id = $1 OR number_id = $2 ORDER BY created_at DESC LIMIT 1`,
      [row.id, row.number_id],
    );
    const routeExists = mapping?.status === 'ACTIVE' && Boolean(mapping.freepbx_route_id);
    if (!routeExists) {
      // Route never landed: roll the reservation back instead of pretending.
      await rollbackReservation(row.number_id, row.id, new Error('reservation timed out before the route was created'));
      continue;
    }
    await withTransaction(async (client) => {
      await client.query(
        `UPDATE numbers SET status = 'ASSIGNED', assigned_user_id = $2, assigned_at = COALESCE(assigned_at, now()),
                reserved_at = NULL, reserved_by = NULL, reservation_expires_at = NULL
          WHERE id = $1 AND status IN ('RESERVED')`,
        [row.number_id, row.user_id],
      );
      await client.query(
        `UPDATE number_assignments SET status = 'ACTIVE', freepbx_route_id = $2, route_synced_at = now() WHERE id = $1`,
        [row.id, mapping?.freepbx_route_id ?? null],
      );
      await writeAudit({
        client,
        actorType: 'WORKER',
        action: 'NUMBER_ASSIGNED',
        result: 'PARTIAL',
        targetType: 'number',
        targetId: row.number_id,
        targetRef: maskNumber(row.phone_number),
        reason: 'recovered a stuck reservation after a crash between PBX success and DB commit',
        metadata: { recovered: true, routeId: mapping?.freepbx_route_id ?? null },
      });
    });
    fixed += 1;
  }
  return fixed;
}

/** Verifies the PBX still holds the extension behind an assignment. */
export async function verifyAssignmentExtension(extension: string): Promise<boolean> {
  const pbx = getFreePBX();
  const ext = await pbx.getExtension(extension);
  return Boolean(ext);
}

export async function enqueueAssignmentVerification(numberId: string, assignmentId: string): Promise<void> {
  await enqueueJob({
    jobType: 'ROUTE_VERIFY',
    entityType: 'assignment',
    entityId: assignmentId,
    idempotencyKey: `verify:${numberId}:${assignmentId}`,
    payload: { numberId, assignmentId },
  });
}

/** Guard used by handlers: only admins or the owner may act on a number. */
export function assertOwnership(number: { assigned_user_id: string | null }, userId: string): void {
  if (number.assigned_user_id && number.assigned_user_id !== userId) {
    throw forbidden('This number belongs to another user.');
  }
}
