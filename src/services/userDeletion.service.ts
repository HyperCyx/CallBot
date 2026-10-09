/**
 * Account deletion: the one place that knows what "delete this account" means.
 *
 * Operator order 2026-10-08: when an admin deletes a user, that user's data is
 * GONE — from every table that references it and from the Telegram session
 * store. A deleted user who sends /start afterwards is treated as brand new:
 * the channel/group gate runs again and the captcha is shown again (the stale
 * bot_sessions row that used to survive is deleted here — that was the live
 * bug where a deleted user never saw the captcha again).
 *
 * Also unchanged by the order (spec §28): deleting must never leave behind
 *   * a number still assigned to a user that no longer exists,
 *   * an inbound route pointing at a dead extension,
 *   * a SIP account / PBX extension nobody owns.
 *
 * History that merely *mentions* the user (audit log, CSV import records,
 * other users' approvals) keeps its row with the reference nulled — the audit
 * trail itself survives, the user does not.
 *
 * Both callers - the Telegram admin panel and DELETE /api/admin/users/:id - go
 * through this function so the two can never drift apart.
 */
import { one, withTransaction } from '../db/pool.js';
import { logger } from '../lib/logger.js';
import { notFound } from '../lib/errors.js';
import { releaseNumber } from './assignment.service.js';
import { deleteSipAccount, getSipAccountByUser } from './extension.service.js';
import { writeAudit } from './audit.service.js';

export interface AccountDeletionResult {
  userId: string;
  /** Numbers that were bound to the account and went back to inventory. */
  releasedNumbers: number;
  /** True when a SIP account existed and its PBX extension was torn down. */
  sipAccountDeleted: boolean;
  /** Number of rows physically removed across the database. */
  purgedRows: number;
}

/**
 * Every table column that REFERS to users(id) but belongs to a row the admin
 * keeps. NOTE: audit_logs is deliberately NOT in this list - §28 makes it
 * immutable by database trigger (deny_mutation) and its actor_id FK is the
 * reason a user can never be physically removed once they have any audit
 * record. The users row is anonymized instead of deleted (see below).
 */
const NULLIFY_REFERENCES: ReadonlyArray<{ table: string; column: string }> = [
  { table: 'admin_settings', column: 'updated_by' },
  { table: 'deposit_requests', column: 'decided_by' },
  { table: 'idempotency_keys', column: 'actor_id' },
  { table: 'number_assignments', column: 'assigned_by' },
  { table: 'number_assignments', column: 'released_by' },
  { table: 'number_import_batches', column: 'actor_id' },
  { table: 'reconciliation_findings', column: 'resolved_by' },
  { table: 'referral_commissions', column: 'paid_by' },
  { table: 'user_roles', column: 'granted_by' },
  { table: 'users', column: 'approved_by' },
  { table: 'users', column: 'referred_by' },
];

export async function deleteUserAccount(
  userId: string,
  opts: { actorId: string; actorTelegramId?: number | null; requestId?: string | null; reason?: string },
): Promise<AccountDeletionResult> {
  const user = await one<{ id: string; username: string | null; telegram_id: number }>(
    'SELECT id, username, telegram_id FROM users WHERE id = $1 AND deleted_at IS NULL',
    [userId],
  );
  if (!user) throw notFound('User');

  const reason = opts.reason ?? 'user account deleted';
  const telegramId = user.telegram_id;

  // 1. Every number still bound to the account - assigned, suspended, or held
  //    as a live reservation - goes back to inventory. releaseNumber removes
  //    the DID route BEFORE freeing the row, so the PBX never points at an
  //    extension the account no longer has.
  const numbers = await oneOrManyNumbers(userId);

  let releasedNumbers = 0;
  for (const number of numbers) {
    await releaseNumber(number.id, {
      actorId: opts.actorId,
      actorTelegramId: opts.actorTelegramId ?? null,
      actorType: 'ADMIN',
      reason,
      requestId: opts.requestId ?? null,
    });
    releasedNumbers += 1;
  }

  // 2. Tear the SIP account down on the PBX as well. A PBX hiccup must not make
  //    an account undeletable: deleteExtension already queues a durable job and
  //    the reconciler converges, so this is logged, not fatal.
  const account = await getSipAccountByUser(userId);
  let sipAccountDeleted = false;
  if (account) {
    try {
      await deleteSipAccount(userId, { actorId: opts.actorId, force: true, requestId: opts.requestId ?? null });
      sipAccountDeleted = true;
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, userId, extension: account.extension },
        'sip account delete failed during account deletion; queued for reconciliation',
      );
    }
  }

  // 3. HARD PURGE (operator order 2026-10-08): the user disappears from every
  //    table. Order matters: leaf rows first (wallet txns inside wallets,
  //    commissions inside referrals), the user row last. One transaction - the
  //    purge is all-or-nothing so a half-deleted account is impossible.
  const purgedRows = await withTransaction(async (client) => {
    let removed = 0;
    const del = async (sql: string, params: unknown[]): Promise<void> => {
      const res = await client.query(sql, params);
      removed += res.rowCount ?? 0;
    };
    const nul = async (sql: string, params: unknown[]): Promise<void> => {
      await client.query(sql, params);
    };

    const uid = userId;
    // Leaves first
    await del('DELETE FROM wallet_transactions WHERE wallet_user_id=$1', [uid]);
    await del(
      `DELETE FROM referral_commissions
        WHERE referrer_user_id=$1
           OR referral_id IN (SELECT id FROM referrals WHERE referrer_user_id=$1 OR referred_user_id=$1)`,
      [uid],
    );
    await del('DELETE FROM referrals WHERE referrer_user_id=$1 OR referred_user_id=$1', [uid]);
    await del('DELETE FROM referral_codes WHERE user_id=$1', [uid]);
    await del('DELETE FROM deposit_requests WHERE user_id=$1', [uid]);
    await del('DELETE FROM notifications WHERE user_id=$1', [uid]);
    await del('DELETE FROM call_history WHERE user_id=$1', [uid]);
    await del('DELETE FROM call_sessions WHERE user_id=$1', [uid]);
    await del('DELETE FROM extension_allocations WHERE user_id=$1', [uid]);
    await del('DELETE FROM number_assignments WHERE user_id=$1', [uid]);
    await del('DELETE FROM user_roles WHERE user_id=$1', [uid]);
    await del('DELETE FROM sip_accounts WHERE user_id=$1', [uid]);
    await del('DELETE FROM wallets WHERE user_id=$1', [uid]);
    await del('DELETE FROM telegram_accounts WHERE user_id=$1 OR telegram_id=$2', [uid, telegramId]);

    // Telegram session store: every row for this account, especially the one
    // carrying captchaPassed=true — the root of the "deleted user skips
    // captcha" bug (keyed "<chatId>:<userId>", "<userId>:<userId>" in DMs).
    await del('DELETE FROM bot_sessions WHERE key = $1 OR key LIKE $2', [`${telegramId}:${telegramId}`, `%:${telegramId}`]);

    // References that must keep their rows (audit trail, other users' history)
    for (const ref of NULLIFY_REFERENCES) {
      await nul(`UPDATE ${ref.table} SET ${ref.column} = NULL WHERE ${ref.column} = $1`, [uid]);
    }
    // Belt & suspenders: numbers are already released above, never let a
    // dangling reference block the delete either way.
    await nul('UPDATE numbers SET assigned_user_id=NULL, reserved_by=NULL WHERE assigned_user_id=$1 OR reserved_by=$1', [uid]);

    // The user row itself LAST - but as an anonymized shell, not a physical
    // delete: the immutable audit trail (§28, trigger-enforced) references it.
    // telegram_id and referral_code are freed (both have unique indexes, NULLs
    // never collide), so a returning Telegram account registers again as a
    // 100% new user - new uuid, new referral code, zero carried data - which
    // IS the operator's "all the data of the user is lost" requirement: every
    // data row is physically gone above; only this empty tombstone remains to
    // keep audit_logs' hash chain valid.
    await nul(
      `UPDATE users SET
         telegram_id = NULL, username = NULL, display_name = NULL, email = NULL,
         referral_code = NULL, plan_id = NULL,
         approved_by = NULL, approved_at = NULL, blocked_at = NULL, blocked_reason = NULL,
         expires_at = NULL, referral_qualified_at = NULL, referred_by = NULL,
         notes = NULL, metadata = '{}'::jsonb, last_seen_at = NULL,
         status = 'DELETED', deleted_at = now(), updated_at = now()
       WHERE id = $1`,
      [uid],
    );
    return removed;
  });

  // Audit AFTER the purge committed (hash-chain columns are writeAudit's job);
  // actor stays the deleting admin, target the vanished user id.
  await writeAudit({
    actorId: opts.actorId,
    actorTelegramId: opts.actorTelegramId ?? null,
    actorType: 'ADMIN',
    action: 'USER_PURGED',
    targetType: 'user',
    targetId: userId,
    requestId: opts.requestId ?? null,
    metadata: { telegramId, username: user.username ?? null, releasedNumbers, sipAccountDeleted, purgedRows, reason },
  }).catch((err) => logger.warn({ err: (err as Error).message }, 'purge audit write failed'));

  logger.info({ userId, telegramId, releasedNumbers, sipAccountDeleted, purgedRows }, 'user account deleted (full purge)');
  return { userId, releasedNumbers, sipAccountDeleted, purgedRows };
}

async function oneOrManyNumbers(userId: string): Promise<Array<{ id: string }>> {
  const { pool } = await import('../db/pool.js');
  const res = await pool.query<{ id: string }>(
    `SELECT id FROM numbers
      WHERE status IN ('ASSIGNED','SUSPENDED','RESERVED')
        AND (assigned_user_id = $1 OR reserved_by = $1)`,
    [userId],
  );
  return res.rows;
}
