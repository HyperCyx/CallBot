import { AppError, badInput, conflict, notFound } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { many, one, query, withTransaction } from '../db/pool.js';
import { writeAudit } from './audit.service.js';
import { creditWallet, adjustWallet, formatUsd, getWallet } from './wallet.service.js';
import { enqueueAdminNotification, enqueueNotification } from './notification.service.js';

/**
 * Manual deposits (operator decision 2026-10-08).
 *
 * There is no payment gateway: money moves offline (bKash/bank/crypto/cash) and
 * the bot models only the bookkeeping + the admin approval step:
 *
 *   1. user files a deposit request (amount + optional payment reference);
 *   2. admins get a DM with ✅ Approve / ❌ Reject (same pattern as user
 *      approvals) and the same queue lives in the admin panel;
 *   3. approve → wallet credited once (status guard makes a double-tap or a
 *      DM+panel race a no-op), user is notified with their new balance;
 *   4. admin can also fund an account directly from the user card (no
 *      request) - that is an ADMIN_ADJUSTMENT ledger line, fully audited.
 */

export interface DepositRequestRow {
  id: string;
  user_id: string;
  amount_cents: number;
  currency: string;
  /** The transaction ID / hash the user sent (kept in the original `note` column). */
  note: string | null;
  /** Payment method (Binance Pay / USDT / …) the money was sent through. */
  payment_method_id: string | null;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
  requested_at: Date;
  decided_at: Date | null;
  decided_by: string | null;
  decision_note: string | null;
}

export const DEPOSIT_MIN_CENTS = 50;
export const DEPOSIT_MAX_CENTS = 1_000_000; // $10,000 per request

/** Parses a user-typed amount ("10", "10.50", "$4,5 hint") into cents or null. */
export function parseDepositAmountCents(input: string): number | null {
  const cleaned = input.trim().replace(/[$\s]/g, '').replace(',', '.');
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(cleaned)) return null;
  const whole = Number.parseFloat(cleaned);
  if (!Number.isFinite(whole)) return null;
  const cents = Math.round(whole * 100);
  if (cents < DEPOSIT_MIN_CENTS || cents > DEPOSIT_MAX_CENTS) return null;
  return cents;
}

export async function pendingDepositForUser(userId: string): Promise<DepositRequestRow | null> {
  return one<DepositRequestRow>("SELECT * FROM deposit_requests WHERE user_id = $1 AND status = 'PENDING'", [userId]);
}

export async function createDepositRequest(
  userId: string,
  opts: { amountCents: number; methodId: string; txid: string; telegramId: number; displayName: string },
): Promise<DepositRequestRow> {
  if (!Number.isSafeInteger(opts.amountCents) || opts.amountCents < DEPOSIT_MIN_CENTS || opts.amountCents > DEPOSIT_MAX_CENTS) {
    throw badInput(`Amount must be between ${formatUsd(DEPOSIT_MIN_CENTS)} and ${formatUsd(DEPOSIT_MAX_CENTS)}.`);
  }
  const method = await one<{ id: string; name: string; status: string }>(
    'SELECT id, name, status FROM payment_methods WHERE id = $1',
    [opts.methodId],
  );
  if (!method) throw notFound('Payment method');
  if (method.status !== 'ACTIVE') throw conflict('This payment method is no longer available - pick another one.');

  const txid = opts.txid.trim();
  if (txid.length < 4 || txid.length > 200) {
    throw badInput('Transaction ID must be 4–200 characters (e.g. the TXID / order ID from your payment).');
  }

  const existing = await pendingDepositForUser(userId);
  if (existing) throw conflict(`You already have a pending deposit request (#${existing.id.slice(0, 8)}). Wait for a decision or cancel it first.`);

  const row = await one<DepositRequestRow>(
    `INSERT INTO deposit_requests (user_id, amount_cents, note, payment_method_id)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (user_id) WHERE status = 'PENDING' DO NOTHING
     RETURNING *`,
    [userId, opts.amountCents, txid, method.id],
  );
  if (!row) throw conflict('You already have a pending deposit request.');

  await enqueueAdminNotification(
    'ADMIN_DEPOSIT_REQUEST',
    {
      requestId: row.id,
      userId,
      telegramId: opts.telegramId,
      displayName: opts.displayName,
      amountCents: row.amount_cents,
      methodName: method.name,
      txid: row.note,
      requestedAt: row.requested_at.toISOString().slice(0, 16).replace('T', ' '),
    },
    `depositreq:${row.id}`,
  );
  return row;
}

export async function cancelDepositRequest(userId: string): Promise<boolean> {
  const res = await query(
    `UPDATE deposit_requests SET status = 'CANCELLED', decided_at = now() WHERE user_id = $1 AND status = 'PENDING' RETURNING id`,
    [userId],
  );
  return res.rows.length > 0;
}

export async function getDepositRequest(id: string): Promise<DepositRequestRow> {
  const row = await one<DepositRequestRow>('SELECT * FROM deposit_requests WHERE id = $1', [id]);
  if (!row) throw notFound('Deposit request');
  return row;
}

export function renderDepositAmount(request: DepositRequestRow): string {
  return formatUsd(request.amount_cents, request.currency);
}

/** ✅ Approve: credit exactly once (the PENDING guard is the idempotence). */
export async function approveDepositRequest(
  requestId: string,
  opts: { adminId: string; adminTelegramId?: number | null; requestId?: string | null },
): Promise<{ request: DepositRequestRow; alreadyDone: boolean; newBalanceCents: number }> {
  const outcome = await withTransaction(async (client) => {
    const locked = await client.query<DepositRequestRow>(
      "SELECT * FROM deposit_requests WHERE id = $1 FOR UPDATE",
      [requestId],
    );
    const request = locked.rows[0];
    if (!request) throw notFound('Deposit request');
    if (request.status !== 'PENDING') return { request, alreadyDone: true, newBalanceCents: -1 };

    const ledger = await creditWallet(request.user_id, request.amount_cents, {
      reference: `deposit:${request.id}`,
      actorType: 'ADMIN',
      actorId: opts.adminId,
      metadata: { note: request.note },
      client,
    });
    const decided = await client.query<DepositRequestRow>(
      `UPDATE deposit_requests
          SET status = 'APPROVED', decided_at = now(), decided_by = $2
        WHERE id = $1 AND status = 'PENDING'
        RETURNING *`,
      [requestId, opts.adminId],
    );
    await writeAudit({
      client,
      actorId: opts.adminId,
      actorTelegramId: opts.adminTelegramId ?? null,
      actorType: 'ADMIN',
      action: 'DEPOSIT_APPROVED',
      targetType: 'deposit_request',
      targetId: requestId,
      metadata: { amountCents: request.amount_cents, userId: request.user_id, ledgerId: ledger.id },
      requestId: opts.requestId ?? null,
    });
    return { request: decided.rows[0]!, alreadyDone: false, newBalanceCents: ledger.balance_after_cents };
  });

  if (!outcome.alreadyDone) {
    await enqueueNotification({
      userId: outcome.request.user_id,
      kind: 'USER_DEPOSIT_APPROVED',
      payload: {
        requestId: outcome.request.id,
        amountCents: outcome.request.amount_cents,
        newBalanceCents: outcome.newBalanceCents,
      },
      dedupeKey: `deposit-approved:${outcome.request.id}`,
    });
  }
  return outcome;
}

/** ❌ Reject: mark decision; no balance movement. */
export async function rejectDepositRequest(
  requestId: string,
  opts: { adminId: string; adminTelegramId?: number | null; note?: string | null; requestId?: string | null },
): Promise<{ request: DepositRequestRow; alreadyDone: boolean }> {
  const outcome = await withTransaction(async (client) => {
    const locked = await client.query<DepositRequestRow>("SELECT * FROM deposit_requests WHERE id = $1 FOR UPDATE", [requestId]);
    const request = locked.rows[0];
    if (!request) throw notFound('Deposit request');
    if (request.status !== 'PENDING') return { request, alreadyDone: true };
    const decided = await client.query<DepositRequestRow>(
      `UPDATE deposit_requests
          SET status = 'REJECTED', decided_at = now(), decided_by = $2, decision_note = $3
        WHERE id = $1 AND status = 'PENDING'
        RETURNING *`,
      [requestId, opts.adminId, opts.note ?? null],
    );
    await writeAudit({
      client,
      actorId: opts.adminId,
      actorTelegramId: opts.adminTelegramId ?? null,
      actorType: 'ADMIN',
      action: 'DEPOSIT_REJECTED',
      targetType: 'deposit_request',
      targetId: requestId,
      metadata: { amountCents: request.amount_cents, userId: request.user_id },
      requestId: opts.requestId ?? null,
    });
    return { request: decided.rows[0]!, alreadyDone: false };
  });

  if (!outcome.alreadyDone) {
    await enqueueNotification({
      userId: outcome.request.user_id,
      kind: 'USER_DEPOSIT_REJECTED',
      payload: { requestId: outcome.request.id, amountCents: outcome.request.amount_cents, note: opts.note ?? null },
      dedupeKey: `deposit-rejected:${outcome.request.id}`,
    });
  }
  return outcome;
}

/** Direct admin funding from a user card; bypasses the request flow. */
export async function adminFundWallet(
  targetUserId: string,
  deltaCents: number,
  opts: { adminId: string; adminTelegramId?: number | null; reason: string; requestId?: string | null },
): Promise<{ newBalanceCents: number }> {
  if (!Number.isSafeInteger(deltaCents) || deltaCents === 0) throw badInput('Amount must be non-zero cents.');
  if (Math.abs(deltaCents) > 10_000_000) throw badInput('Amount out of range.');

  const result = await withTransaction(async (client) => {
    const walletBefore = await getWallet(targetUserId, client);
    if (walletBefore.balance_cents + deltaCents < 0) {
      throw new AppError('INSUFFICIENT_FUNDS', `Adjustment would take the balance below zero (current ${formatUsd(walletBefore.balance_cents)}).`);
    }
    const ledger = await adjustWallet(targetUserId, deltaCents, {
      reference: `admin-fund:${opts.adminId}:${Date.now()}`,
      actorType: 'ADMIN',
      actorId: opts.adminId,
      metadata: { reason: opts.reason },
      client,
    });
    await writeAudit({
      client,
      actorId: opts.adminId,
      actorTelegramId: opts.adminTelegramId ?? null,
      actorType: 'ADMIN',
      action: 'WALLET_ADJUSTED',
      targetType: 'wallet',
      targetId: targetUserId,
      metadata: { deltaCents, reason: opts.reason, ledgerId: ledger.id },
      requestId: opts.requestId ?? null,
    });
    return { newBalanceCents: ledger.balance_after_cents };
  });

  await enqueueNotification({
    userId: targetUserId,
    kind: 'WALLET_CREDITED',
    payload: { deltaCents, newBalanceCents: result.newBalanceCents, reason: opts.reason },
    dedupeKey: null,
  });
  return result;
}

export interface PendingDepositWithUser extends DepositRequestRow {
  telegram_id: number | null;
  username: string | null;
  display_name: string | null;
  method_name: string | null;
}

export async function listPendingDeposits(limit = 10): Promise<PendingDepositWithUser[]> {
  return many<PendingDepositWithUser>(
    `SELECT d.*, u.telegram_id, u.username, u.display_name, m.name AS method_name
       FROM deposit_requests d
       JOIN users u ON u.id = d.user_id
       LEFT JOIN payment_methods m ON m.id = d.payment_method_id
      WHERE d.status = 'PENDING'
      ORDER BY d.requested_at ASC
      LIMIT $1`,
    [Math.max(1, Math.min(25, limit))],
  );
}
