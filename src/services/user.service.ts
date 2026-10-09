import type { DbClient } from '../db/pool.js';
import { many, one, query, scalar, withTransaction } from '../db/pool.js';
import { env } from '../config/env.js';
import { AppError, conflict, forbidden, notFound } from '../lib/errors.js';
import { generateReferralCode } from '../lib/crypto.js';
import { addDays } from '../lib/time.js';
import { writeAudit } from './audit.service.js';
import { getDefaultPlan, getPlan } from './catalog.service.js';
import { getNumber as getSettingNumber, getString } from './settings.service.js';

/**
 * User lifecycle (spec §4, §5, §19).
 *
 *   /start -> telegram_accounts row (exists for everyone who ever opened the bot)
 *          -> captcha -> users row with status PENDING
 *          -> admin approve -> status ACTIVE + SIP account + test number
 *          -> block/unblock/expire/delete
 *
 * Admin identity is resolved from BOTH the TELEGRAM_SUPER_ADMIN_IDS allowlist
 * (bootstrap, cannot be locked out) and the roles table (RBAC, spec §27).
 */

export interface UserRow {
  id: string;
  telegram_id: number | null;
  username: string | null;
  display_name: string | null;
  language_code: string;
  email: string | null;
  status: 'PENDING' | 'ACTIVE' | 'BLOCKED' | 'EXPIRED' | 'DELETED';
  plan_id: string | null;
  plan_code?: string | null;
  plan_name?: string | null;
  referral_code: string | null;
  referred_by: string | null;
  referral_qualified_at: Date | null;
  created_at: Date;
  approved_at: Date | null;
  blocked_at: Date | null;
  blocked_reason: string | null;
  expires_at: Date | null;
  deleted_at: Date | null;
  notes: string | null;
}

export interface TelegramAccountRow {
  id: string;
  telegram_id: number;
  user_id: string | null;
  chat_id: number | null;
  username: string | null;
  first_name: string | null;
  last_name: string | null;
  captcha_passed_at: Date | null;
  captcha_attempts: number;
  membership_ok: boolean | null;
  banned: boolean;
  ban_reason: string | null;
}

// -----------------------------------------------------------------------------
// Telegram account bookkeeping
// -----------------------------------------------------------------------------

export async function upsertTelegramAccount(input: {
  telegramId: number;
  chatId?: number;
  username?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  languageCode?: string | null;
  lastUpdateId?: number | null;
}): Promise<TelegramAccountRow> {
  const row = await one<TelegramAccountRow>(
    `INSERT INTO telegram_accounts (telegram_id, chat_id, username, first_name, last_name, language_code, last_update_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (telegram_id) DO UPDATE SET
        chat_id = COALESCE(EXCLUDED.chat_id, telegram_accounts.chat_id),
        username = COALESCE(EXCLUDED.username, telegram_accounts.username),
        first_name = COALESCE(EXCLUDED.first_name, telegram_accounts.first_name),
        last_name = COALESCE(EXCLUDED.last_name, telegram_accounts.last_name),
        language_code = COALESCE(EXCLUDED.language_code, telegram_accounts.language_code),
        last_update_id = COALESCE(EXCLUDED.last_update_id, telegram_accounts.last_update_id)
     RETURNING *`,
    [
      input.telegramId,
      input.chatId ?? null,
      input.username ?? null,
      input.firstName ?? null,
      input.lastName ?? null,
      input.languageCode ?? null,
      input.lastUpdateId ?? null,
    ],
  );
  return row!;
}

export async function getTelegramAccount(telegramId: number): Promise<TelegramAccountRow | null> {
  return one<TelegramAccountRow>('SELECT * FROM telegram_accounts WHERE telegram_id = $1', [telegramId]);
}

export async function recordCaptchaAttempt(telegramId: number, passed: boolean): Promise<void> {
  await query(
    `UPDATE telegram_accounts
        SET captcha_attempts = captcha_attempts + 1,
            captcha_passed_at = CASE WHEN $2 THEN COALESCE(captcha_passed_at, now()) ELSE captcha_passed_at END
      WHERE telegram_id = $1`,
    [telegramId, passed],
  );
}

export async function setMembershipStatus(telegramId: number, ok: boolean): Promise<void> {
  await query(
    'UPDATE telegram_accounts SET membership_ok = $2, membership_checked_at = now() WHERE telegram_id = $1',
    [telegramId, ok],
  );
}

// -----------------------------------------------------------------------------
// Users
// -----------------------------------------------------------------------------

export async function getUserById(id: string): Promise<UserRow | null> {
  return one<UserRow>(
    `SELECT u.*, p.code AS plan_code, p.name AS plan_name
       FROM users u LEFT JOIN plans p ON p.id = u.plan_id
      WHERE u.id = $1`,
    [id],
  );
}

export async function getUserByTelegramId(telegramId: number): Promise<UserRow | null> {
  return one<UserRow>(
    `SELECT u.*, p.code AS plan_code, p.name AS plan_name
       FROM users u LEFT JOIN plans p ON p.id = u.plan_id
      WHERE u.telegram_id = $1 AND u.deleted_at IS NULL`,
    [telegramId],
  );
}

export async function findUserForTelegram(telegramId: number): Promise<UserRow | null> {
  const direct = await getUserByTelegramId(telegramId);
  if (direct) return direct;
  return one<UserRow>(
    `SELECT u.*, p.code AS plan_code, p.name AS plan_name
       FROM users u
       JOIN telegram_accounts t ON t.user_id = u.id
       LEFT JOIN plans p ON p.id = u.plan_id
      WHERE t.telegram_id = $1 AND u.deleted_at IS NULL`,
    [telegramId],
  );
}

export interface RegisterResult {
  user: UserRow;
  created: boolean;
}

/**
 * Creates (or returns) the PENDING application-level user for a Telegram
 * account that has passed the captcha.
 *
 * Referral handling is done here because it is the only moment at which the
 * attribution can be trusted (spec §23: no self-referrals, no duplicate credit).
 */
export async function registerUser(input: {
  telegramId: number;
  username?: string | null;
  displayName?: string | null;
  languageCode?: string | null;
  referralCodeFromStart?: string | null;
}): Promise<RegisterResult> {
  return withTransaction(async (client) => {
    const existing = await client.query<UserRow>(
      `SELECT u.*, p.code AS plan_code, p.name AS plan_name FROM users u
         LEFT JOIN plans p ON p.id = u.plan_id
        WHERE u.telegram_id = $1 AND u.deleted_at IS NULL`,
      [input.telegramId],
    );
    if (existing.rows[0]) {
      // Keep profile fields fresh but never touch status here.
      const updated = await client.query<UserRow>(
        `UPDATE users SET username = COALESCE($2, username), display_name = COALESCE($3, display_name), last_seen_at = now()
          WHERE id = $1 RETURNING *`,
        [existing.rows[0].id, input.username ?? null, input.displayName ?? null],
      );
      return { user: { ...existing.rows[0], ...updated.rows[0] } as UserRow, created: false };
    }

    const plan = await getDefaultPlan();
    const expiryDays = await getSettingNumber('registration.default_expiry_days', env.DEFAULT_USER_EXPIRES_DAYS);
    const code = await generateUniqueReferralCode();

    let referredBy: string | null = null;
    let referralCodeUsed: string | null = null;
    if (input.referralCodeFromStart) {
      // The referrer is the user who OWNS the code (users.referral_code is the
      // single source for a user's code; referral_codes mirrors it for clicks).
      const codeRow = await client.query<{ id: string; telegram_id: number | null }>(
        `SELECT id, telegram_id FROM users
          WHERE referral_code = $1 AND deleted_at IS NULL AND status NOT IN ('DELETED', 'BLOCKED')`,
        [input.referralCodeFromStart],
      );
      const referrer = codeRow.rows[0];
      if (referrer) {
        // Guard: no self-referral (belt and braces - the DB CHECK also enforces it).
        if (Number(referrer.telegram_id) === input.telegramId) {
          referralCodeUsed = null;
        } else {
          referredBy = referrer.id;
          referralCodeUsed = input.referralCodeFromStart;
        }
      }
    }

    // One statement ends up owning the row, in three situations:
    //  - the account never registered: a fresh PENDING row;
    //  - the account was deleted by an administrator and now re-registers:
    //    the row is revived (PENDING again, approval/blocking/deletion state
    //    cleared) instead of dying on the unique telegram_id constraint
    //    (reproduced live: DELETE account -> /start -> duplicate key 500);
    //  - two /start taps race: the loser's INSERT conflicts, the WHERE clause
    //    declines to touch the winner's live row, RETURNING is empty, and the
    //    loser simply loads the row the winner created.
    const created = await client.query<UserRow>(
      `INSERT INTO users (telegram_id, username, display_name, language_code, status, plan_id,
                          referral_code, referred_by, expires_at)
       VALUES ($1,$2,$3,$4,'PENDING',$5,$6,$7,$8)
       ON CONFLICT (telegram_id) DO UPDATE SET
            username        = COALESCE(EXCLUDED.username, users.username),
            display_name    = COALESCE(EXCLUDED.display_name, users.display_name),
            language_code   = COALESCE(EXCLUDED.language_code, users.language_code),
            status          = 'PENDING',
            plan_id         = COALESCE(users.plan_id, EXCLUDED.plan_id),
            referred_by     = COALESCE(users.referred_by, EXCLUDED.referred_by),
            expires_at      = EXCLUDED.expires_at,
            approved_at     = NULL, approved_by = NULL,
            blocked_at      = NULL, blocked_reason = NULL,
            deleted_at      = NULL,
            last_seen_at    = now()
        WHERE users.deleted_at IS NOT NULL
       RETURNING *`,
      [
        input.telegramId,
        input.username ?? null,
        input.displayName ?? null,
        input.languageCode ?? 'en',
        plan?.id ?? null,
        code,
        referredBy,
        addDays(new Date(), expiryDays),
      ],
    );
    const user = created.rows[0];
    if (!user) {
      // A live (non-deleted) row owns this telegram_id: the other /start tap
      // created it moments ago. Read it back and carry on.
      const winner = await client.query<UserRow>(
        `SELECT u.*, p.code AS plan_code, p.name AS plan_name FROM users u
           LEFT JOIN plans p ON p.id = u.plan_id
          WHERE u.telegram_id = $1 AND u.deleted_at IS NULL`,
        [input.telegramId],
      );
      if (!winner.rows[0]) throw new AppError('INTERNAL', 'Registration could not read back the user.');
      return { user: winner.rows[0], created: false };
    }

    // Mirror the referral code in the dedicated table (rotation/clicks support).
    // The row's own code is mirrored - a revived user keeps their original
    // code, so mirroring the freshly drawn one would leave an orphan code.
    await client.query(
      `INSERT INTO referral_codes (code, user_id) VALUES ($1,$2) ON CONFLICT (code) DO NOTHING`,
      [user.referral_code, user.id],
    );

    if (referredBy && referralCodeUsed) {
      try {
        await client.query(
          `INSERT INTO referrals (referrer_user_id, referred_user_id, referral_code, qualification_rule)
           VALUES ($1,$2,$3,$4) ON CONFLICT (referred_user_id) DO NOTHING`,
          [referredBy, user.id, referralCodeUsed, await getString('referral.qualification_rule', 'FIRST_NUMBER_ASSIGNED')],
        );
      } catch {
        // A unique violation here means the user was already credited; ignore.
      }
    }

    // Link the telegram account to the user record.
    await client.query('UPDATE telegram_accounts SET user_id = $2 WHERE telegram_id = $1', [input.telegramId, user.id]);

    await writeAudit({
      client,
      actorId: user.id,
      actorTelegramId: input.telegramId,
      actorType: 'USER',
      action: 'USER_REGISTERED',
      targetType: 'user',
      targetId: user.id,
      targetRef: input.username ?? String(input.telegramId),
      metadata: { referredBy: referredBy ? 'yes' : 'no' },
    });

    return { user, created: true };
  });
}

async function generateUniqueReferralCode(): Promise<string> {
  for (let i = 0; i < 10; i += 1) {
    const code = generateReferralCode(8);
    const exists = await scalar<number>('SELECT 1 FROM users WHERE referral_code = $1', [code]);
    if (!exists) return code;
  }
  // Fall back to a longer code rather than failing registration.
  return generateReferralCode(12);
}

export interface ApproveOptions {
  actorId: string;
  actorTelegramId?: number | null;
  planId?: string | null;
  expiresInDays?: number;
  requestId?: string | null;
}

/**
 * Approves a pending user: status ACTIVE, plan + expiry applied.
 * SIP provisioning is intentionally NOT done here - the caller invokes
 * `provisionSipAccount` so the PBX call happens outside this transaction and a
 * PBX failure cannot roll back the human decision to approve.
 */
export async function approveUser(userId: string, opts: ApproveOptions): Promise<UserRow> {
  return withTransaction(async (client) => {
    const current = await client.query<UserRow>('SELECT * FROM users WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [userId]);
    const user = current.rows[0];
    if (!user) throw notFound('User');
    if (user.status === 'ACTIVE') throw conflict('This user is already active');
    if (user.status === 'BLOCKED') throw conflict('This user is blocked. Unblock them instead.');

    const plan = opts.planId ? await getPlan(opts.planId) : (user.plan_id ? await getPlan(user.plan_id) : await getDefaultPlan());
    const days = opts.expiresInDays ?? plan?.duration_days ?? env.DEFAULT_USER_EXPIRES_DAYS;

    const updated = await client.query<UserRow>(
      `UPDATE users SET status = 'ACTIVE', approved_at = now(), approved_by = $2,
                        plan_id = COALESCE($3, plan_id), expires_at = $4, blocked_at = NULL, blocked_reason = NULL
        WHERE id = $1 RETURNING *`,
      [userId, opts.actorId, plan?.id ?? null, addDays(new Date(), days)],
    );

    await writeAudit({
      client,
      actorId: opts.actorId,
      actorTelegramId: opts.actorTelegramId ?? null,
      actorType: 'ADMIN',
      action: 'USER_APPROVED',
      targetType: 'user',
      targetId: userId,
      targetRef: user.username ?? String(user.telegram_id),
      requestId: opts.requestId ?? null,
      metadata: { plan: plan?.code ?? null, expiresInDays: days },
    });

    return updated.rows[0]!;
  });
}

export async function rejectUser(userId: string, opts: { actorId: string; reason?: string; requestId?: string | null }): Promise<void> {
  await withTransaction(async (client) => {
    await client.query("UPDATE users SET status = 'BLOCKED', blocked_at = now(), blocked_reason = $2 WHERE id = $1", [
      userId,
      opts.reason ?? 'rejected at registration',
    ]);
    await writeAudit({
      client,
      actorId: opts.actorId,
      actorType: 'ADMIN',
      action: 'USER_REJECTED',
      result: 'SUCCESS',
      targetType: 'user',
      targetId: userId,
      reason: opts.reason ?? 'rejected at registration',
      requestId: opts.requestId ?? null,
    });
  });
}

export async function blockUser(userId: string, opts: { actorId: string; reason?: string; requestId?: string | null }): Promise<void> {
  await withTransaction(async (client) => {
    const user = await client.query<UserRow>('SELECT * FROM users WHERE id = $1 FOR UPDATE', [userId]);
    if (!user.rows[0]) throw notFound('User');
    await client.query("UPDATE users SET status = 'BLOCKED', blocked_at = now(), blocked_reason = $2 WHERE id = $1", [
      userId,
      opts.reason ?? null,
    ]);
    await writeAudit({
      client,
      actorId: opts.actorId,
      actorType: 'ADMIN',
      action: 'USER_BLOCKED',
      targetType: 'user',
      targetId: userId,
      reason: opts.reason ?? null,
      requestId: opts.requestId ?? null,
    });
  });
}

export async function unblockUser(userId: string, opts: { actorId: string; requestId?: string | null }): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE users SET status = 'ACTIVE', blocked_at = NULL, blocked_reason = NULL,
              expires_at = COALESCE(NULLIF(expires_at, NULL), now() + interval '30 days')
        WHERE id = $1`,
      [userId],
    );
    await writeAudit({
      client,
      actorId: opts.actorId,
      actorType: 'ADMIN',
      action: 'USER_UNBLOCKED',
      targetType: 'user',
      targetId: userId,
      requestId: opts.requestId ?? null,
    });
  });
}

/**
 * Soft-deletes a user. Assigned numbers are released through the assignment
 * service by the caller so the PBX stays consistent (never a silent orphan
 * route). Nothing is hard-deleted: audit history must survive (spec §28).
 */
export async function softDeleteUser(
  userId: string,
  opts: { actorId: string; requestId?: string | null; metadata?: Record<string, unknown> },
): Promise<void> {
  await withTransaction(async (client) => {
    const user = await client.query<UserRow>('SELECT * FROM users WHERE id = $1 FOR UPDATE', [userId]);
    if (!user.rows[0]) throw notFound('User');
    await client.query(
      `UPDATE users SET status = 'DELETED', deleted_at = now(), blocked_reason = 'deleted by admin' WHERE id = $1`,
      [userId],
    );
    await client.query('UPDATE telegram_accounts SET user_id = NULL WHERE user_id = $1', [userId]);
    await writeAudit({
      client,
      actorId: opts.actorId,
      actorType: 'ADMIN',
      action: 'USER_DELETED',
      targetType: 'user',
      targetId: userId,
      targetRef: user.rows[0].username ?? null,
      metadata: opts.metadata ?? {},
      requestId: opts.requestId ?? null,
    });
  });
}

export async function changeUserPlan(userId: string, planId: string, opts: { actorId: string; requestId?: string | null }): Promise<void> {
  const plan = await getPlan(planId);
  if (!plan) throw notFound('Plan');
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE users SET plan_id = $2, expires_at = GREATEST(COALESCE(expires_at, now()), now()) + ($3 || ' days')::interval
        WHERE id = $1`,
      [userId, planId, String(plan.duration_days)],
    );
    await writeAudit({
      client,
      actorId: opts.actorId,
      actorType: 'ADMIN',
      action: 'USER_PLAN_CHANGED',
      targetType: 'user',
      targetId: userId,
      metadata: { plan: plan.code },
      requestId: opts.requestId ?? null,
    });
  });
}

export async function touchLastSeen(userId: string): Promise<void> {
  await query('UPDATE users SET last_seen_at = now() WHERE id = $1', [userId]);
}

// -----------------------------------------------------------------------------
// Listing / searching (admin panel, spec §19)
// -----------------------------------------------------------------------------

export interface UserListFilters {
  status?: UserRow['status'] | 'ALL';
  planCode?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

export async function listUsers(filters: UserListFilters = {}): Promise<{ rows: UserRow[]; total: number }> {
  const params: unknown[] = [];
  const conditions: string[] = ['u.deleted_at IS NULL'];

  if (filters.status && filters.status !== 'ALL') {
    params.push(filters.status);
    conditions.push(`u.status = $${params.length}`);
  }
  if (filters.planCode) {
    params.push(filters.planCode);
    conditions.push(`p.code = $${params.length}`);
  }
  if (filters.search) {
    params.push(`%${filters.search}%`);
    conditions.push(`(u.username ILIKE $${params.length} OR u.display_name ILIKE $${params.length} OR u.telegram_id::text LIKE $${params.length} OR u.referral_code ILIKE $${params.length})`);
  }

  const where = `WHERE ${conditions.join(' AND ')}`;
  const limit = Math.min(filters.limit ?? 10, 50);
  const offset = filters.offset ?? 0;

  const total = await scalar<string>(
    `SELECT count(*)::text FROM users u LEFT JOIN plans p ON p.id = u.plan_id ${where}`,
    params,
  );
  params.push(limit, offset);
  const rows = await many<UserRow>(
    `SELECT u.*, p.code AS plan_code, p.name AS plan_name
       FROM users u LEFT JOIN plans p ON p.id = u.plan_id
       ${where}
      ORDER BY u.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return { rows, total: Number(total ?? 0) };
}

export interface UserCounts {
  total: number;
  active: number;
  pending: number;
  blocked: number;
  expired: number;
  premium: number;
}

export async function getUserCounts(): Promise<UserCounts> {
  const row = await one<Record<string, string>>(`
    SELECT
      count(*)::text AS total,
      count(*) FILTER (WHERE status = 'ACTIVE')::text  AS active,
      count(*) FILTER (WHERE status = 'PENDING')::text AS pending,
      count(*) FILTER (WHERE status = 'BLOCKED')::text AS blocked,
      count(*) FILTER (WHERE status = 'EXPIRED')::text AS expired,
      count(*) FILTER (WHERE EXISTS (SELECT 1 FROM plans p WHERE p.id = users.plan_id AND p.rank > 0))::text AS premium
    FROM users WHERE deleted_at IS NULL`);
  return {
    total: Number(row?.total ?? 0),
    active: Number(row?.active ?? 0),
    pending: Number(row?.pending ?? 0),
    blocked: Number(row?.blocked ?? 0),
    expired: Number(row?.expired ?? 0),
    premium: Number(row?.premium ?? 0),
  };
}

export async function listPendingUsers(limit = 5): Promise<UserRow[]> {
  return many<UserRow>(
    `SELECT u.*, p.code AS plan_code FROM users u LEFT JOIN plans p ON p.id = u.plan_id
      WHERE u.status = 'PENDING' AND u.deleted_at IS NULL ORDER BY u.created_at ASC LIMIT $1`,
    [limit],
  );
}

// -----------------------------------------------------------------------------
// RBAC
// -----------------------------------------------------------------------------

export async function getUserRoles(userId: string): Promise<string[]> {
  const rows = await many<{ code: string }>(
    `SELECT r.code FROM user_roles ur JOIN roles r ON r.id = ur.role_id
      WHERE ur.user_id = $1 AND (ur.expires_at IS NULL OR ur.expires_at > now())`,
    [userId],
  );
  return rows.map((r) => r.code);
}

export async function grantRole(userId: string, roleCode: string, grantedBy: string): Promise<void> {
  const role = await one<{ id: string }>('SELECT id FROM roles WHERE code = $1', [roleCode]);
  if (!role) throw notFound('Role');
  await query(
    `INSERT INTO user_roles (user_id, role_id, granted_by) VALUES ($1,$2,$3)
     ON CONFLICT (user_id, role_id) DO NOTHING`,
    [userId, role.id, grantedBy],
  );
  await writeAudit({
    actorId: grantedBy,
    actorType: 'ADMIN',
    action: 'USER_ROLE_GRANTED',
    targetType: 'user',
    targetId: userId,
    metadata: { role: roleCode },
  });
}

export async function revokeRole(userId: string, roleCode: string, actorId: string): Promise<void> {
  await query(
    `DELETE FROM user_roles ur USING roles r WHERE ur.role_id = r.id AND ur.user_id = $1 AND r.code = $2`,
    [userId, roleCode],
  );
  await writeAudit({
    actorId,
    actorType: 'ADMIN',
    action: 'USER_ROLE_REVOKED',
    targetType: 'user',
    targetId: userId,
    metadata: { role: roleCode },
  });
}

export async function getEffectivePermissions(userId: string): Promise<string[]> {
  const rows = await many<{ permissions: string[] }>(
    `SELECT r.permissions FROM user_roles ur JOIN roles r ON r.id = ur.role_id
      WHERE ur.user_id = $1 AND (ur.expires_at IS NULL OR ur.expires_at > now())`,
    [userId],
  );
  const out = new Set<string>();
  for (const row of rows) for (const p of row.permissions ?? []) out.add(p);
  return [...out];
}

/** Permission check supporting wildcards: "numbers:*" grants "numbers:assign". */
export async function hasPermission(userId: string, permission: string): Promise<boolean> {
  const perms = await getEffectivePermissions(userId);
  if (perms.includes('*')) return true;
  if (perms.includes(permission)) return true;
  const [ns] = permission.split(':');
  return perms.includes(`${ns}:*`);
}

export type AdminRole = 'super_admin' | 'admin' | 'support' | 'user';

/**
 * Resolves the caller's highest role. The environment allowlist is authoritative
 * and cannot be removed from the database, which prevents an accidental
 * lock-out of the deployment's owner (spec §27).
 */
export async function resolveRole(telegramId: number, userId?: string | null): Promise<AdminRole> {
  if (env.superAdminIds.includes(String(telegramId))) return 'super_admin';
  if (!userId) return 'user';
  const roles = await getUserRoles(userId);
  if (roles.includes('super_admin')) return 'super_admin';
  if (roles.includes('admin')) return 'admin';
  if (roles.includes('support')) return 'support';
  return 'user';
}

export async function isAdmin(telegramId: number, userId?: string | null): Promise<boolean> {
  const role = await resolveRole(telegramId, userId);
  return role === 'super_admin' || role === 'admin' || role === 'support';
}

export async function requireActiveUser(telegramId: number): Promise<UserRow> {
  const user = await findUserForTelegram(telegramId);
  if (!user) throw forbidden('Please register with /start first.');
  if (user.status === 'BLOCKED') throw forbidden('Your account is blocked. Contact support.');
  if (user.status === 'DELETED') throw forbidden('Your account no longer exists.');
  if (user.status === 'PENDING') throw new AppError('ACCOUNT_NOT_ACTIVE', 'Your registration is awaiting administrator approval.');
  if (user.expires_at && user.expires_at.getTime() < Date.now()) {
    throw new AppError('ACCOUNT_NOT_ACTIVE', 'Your subscription has expired. Please contact support to renew.');
  }
  return user;
}

export async function expireUser(userId: string, reason = 'subscription expired'): Promise<void> {
  await withTransaction(async (client: DbClient) => {
    await client.query(
      `UPDATE users SET status = 'EXPIRED', blocked_reason = $2
        WHERE id = $1 AND status = 'ACTIVE'`,
      [userId, reason],
    );
    await writeAudit({
      client,
      actorType: 'WORKER',
      action: 'USER_BLOCKED',
      targetType: 'user',
      targetId: userId,
      reason,
      metadata: { automatic: true },
    });
  });
}
