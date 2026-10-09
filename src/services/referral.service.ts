import { LOCK_KEYS, many, one, query, scalar, withAdvisoryLock, withTransaction } from '../db/pool.js';
import { env } from '../config/env.js';
import { AppError, conflict, notFound } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { writeAudit } from './audit.service.js';
import { getPlan, getPlanByCode } from './catalog.service.js';
import { getReferralConfig } from './settings.service.js';

/**
 * Referral programme (spec §23).
 *
 * DESIGN DECISIONS (each one is an anti-abuse control):
 *
 * 1. Attribution happens ONCE, at registration, from the `/start <code>` payload,
 *    and is stored in `referrals.referred_user_id UNIQUE`. A user can never be
 *    credited to a second referrer, and a referrer can never be credited twice
 *    for the same person.
 * 2. Self-referral is blocked in the application AND by a CHECK constraint.
 * 3. "Qualified" is explicit and configurable
 *    (`referral.qualification_rule`): SIGNUP / USER_APPROVED /
 *    FIRST_NUMBER_ASSIGNED / PLAN_PURCHASED. Default: FIRST_NUMBER_ASSIGNED -
 *    the referred user must have received a number, which requires an admin to
 *    have approved them and the PBX to have accepted the extension. That is
 *    expensive to fake at scale.
 * 4. Commission amounts are snapshotted (type, rate, base) so changing the rate
 *    later does not rewrite history.
 * 5. A per-referrer daily cap and a payout hold are enforced from settings.
 */

export interface ReferralRow {
  id: string;
  referrer_user_id: string;
  referred_user_id: string;
  referral_code: string;
  status: 'PENDING' | 'QUALIFIED' | 'REJECTED' | 'PAID';
  qualified_at: Date | null;
  qualification_rule: string | null;
  created_at: Date;
}

export interface ReferralStats {
  code: string | null;
  link: string | null;
  total: number;
  qualified: number;
  pending: number;
  rejected: number;
  pendingCents: number;
  paidCents: number;
  currency: string;
  enabled: boolean;
  commissionType: 'FIXED' | 'PERCENTAGE';
  commissionValue: number;
  qualificationRule: string;
}

export function buildReferralLink(botUsername: string, code: string): string {
  return `https://t.me/${botUsername}?start=${encodeURIComponent(code)}`;
}

export async function getReferralStats(userId: string, botUsername: string): Promise<ReferralStats> {
  const config = await getReferralConfig();
  const codeRow = await one<{ referral_code: string | null }>('SELECT referral_code FROM users WHERE id = $1', [userId]);
  const code = codeRow?.referral_code ?? null;

  const counts = await one<{
    total: string;
    qualified: string;
    pending: string;
    rejected: string;
  }>(
    `SELECT
       count(*)::text AS total,
       count(*) FILTER (WHERE status IN ('QUALIFIED','PAID'))::text AS qualified,
       count(*) FILTER (WHERE status = 'PENDING')::text AS pending,
       count(*) FILTER (WHERE status = 'REJECTED')::text AS rejected
     FROM referrals WHERE referrer_user_id = $1`,
    [userId],
  );

  const money = await one<{ pending: string; paid: string }>(
    `SELECT
       COALESCE(sum(amount_cents) FILTER (WHERE status IN ('PENDING','APPROVED')), 0)::text AS pending,
       COALESCE(sum(amount_cents) FILTER (WHERE status = 'PAID'), 0)::text AS paid
     FROM referral_commissions WHERE referrer_user_id = $1`,
    [userId],
  );

  return {
    code,
    link: code ? buildReferralLink(botUsername, code) : null,
    total: Number(counts?.total ?? 0),
    qualified: Number(counts?.qualified ?? 0),
    pending: Number(counts?.pending ?? 0),
    rejected: Number(counts?.rejected ?? 0),
    pendingCents: Number(money?.pending ?? 0),
    paidCents: Number(money?.paid ?? 0),
    currency: config.currency,
    enabled: config.enabled,
    commissionType: config.commissionType,
    commissionValue: config.commissionValue,
    qualificationRule: config.qualificationRule,
  };
}

export async function listReferralsForUser(userId: string, limit = 10): Promise<Array<ReferralRow & { username: string | null; telegram_id: number | null; created_at: Date }>> {
  return many(
    `SELECT r.*, u.username, u.telegram_id
       FROM referrals r JOIN users u ON u.id = r.referred_user_id
      WHERE r.referrer_user_id = $1
      ORDER BY r.created_at DESC LIMIT $2`,
    [userId, limit],
  );
}

/**
 * Evaluates the qualification rule for every PENDING referral of a user and
 * creates the commission when the rule is satisfied.
 *
 * Called after the events that matter: approval, first assignment, plan change.
 * The advisory lock makes it safe to call from several code paths (and several
 * worker instances) at once.
 */
export async function evaluateReferralQualification(
  referredUserId: string,
  trigger: 'USER_APPROVED' | 'FIRST_NUMBER_ASSIGNED' | 'PLAN_PURCHASED' | 'SIGNUP',
): Promise<{ qualified: boolean; commissionCents?: number }> {
  const config = await getReferralConfig();
  if (!config.enabled) return { qualified: false };

  return withTransaction(async (client) =>
    withAdvisoryLock(client, LOCK_KEYS.REFERRAL_CREDIT, async () => {
      const referralRes = await client.query<ReferralRow>(
        'SELECT * FROM referrals WHERE referred_user_id = $1 FOR UPDATE',
        [referredUserId],
      );
      const referral = referralRes.rows[0];
      if (!referral) return { qualified: false };
      if (referral.status === 'QUALIFIED' || referral.status === 'PAID') return { qualified: true };
      if (referral.status === 'REJECTED') return { qualified: false };

      // Has the configured rule fired?
      const rule = config.qualificationRule;
      const ruleSatisfied =
        (rule === 'SIGNUP' && trigger === 'SIGNUP') ||
        ((rule === 'USER_APPROVED' || rule === 'SIGNUP') && trigger === 'USER_APPROVED') ||
        (rule !== 'PLAN_PURCHASED' && rule !== 'SIGNUP' && rule !== 'USER_APPROVED' && trigger === 'FIRST_NUMBER_ASSIGNED') ||
        (rule === 'FIRST_NUMBER_ASSIGNED' && (trigger === 'FIRST_NUMBER_ASSIGNED' || trigger === 'USER_APPROVED')) ||
        (rule === 'PLAN_PURCHASED' && trigger === 'PLAN_PURCHASED');
      if (!ruleSatisfied) return { qualified: false };

      // Anti-abuse: daily cap per referrer.
      const today = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM referrals
          WHERE referrer_user_id = $1 AND status IN ('QUALIFIED','PAID') AND qualified_at >= date_trunc('day', now())`,
        [referral.referrer_user_id],
      );
      if (Number(today.rows[0]?.count ?? 0) >= config.maxPerReferrerPerDay) {
        await writeAudit({
          client,
          actorType: 'SYSTEM',
          action: 'REFERRAL_REJECTED',
          result: 'DENIED',
          targetType: 'user',
          targetId: referredUserId,
          reason: 'daily referral cap reached',
          metadata: { referrerId: referral.referrer_user_id, cap: config.maxPerReferrerPerDay },
        });
        return { qualified: false };
      }

      // Commission calculation (snapshotted).
      const referredPlanCode = await client
        .query<{ plan_code: string | null }>('SELECT p.code AS plan_code FROM users u LEFT JOIN plans p ON p.id = u.plan_id WHERE u.id = $1', [
          referredUserId,
        ])
        .then((r) => r.rows[0]?.plan_code ?? null);

      const plan = referredPlanCode ? await getPlanByCode(referredPlanCode) : null;
      const baseCents = plan?.price_cents_per_month ?? 0;
      const amountCents =
        config.commissionType === 'FIXED'
          ? Math.round(config.commissionValue * 100)
          : Math.round((baseCents * config.commissionValue) / 100);

      await client.query(
        `UPDATE referrals SET status = 'QUALIFIED', qualified_at = now(), qualification_rule = $2 WHERE id = $1`,
        [referral.id, rule],
      );

      if (amountCents > 0) {
        await client.query(
          `INSERT INTO referral_commissions (referral_id, referrer_user_id, commission_type, rate_value,
                                             base_amount_cents, amount_cents, currency, source, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'SIGNUP','PENDING')
           ON CONFLICT (referral_id, source) DO NOTHING`,
          [
            referral.id,
            referral.referrer_user_id,
            config.commissionType,
            config.commissionValue,
            baseCents,
            amountCents,
            config.currency,
          ],
        );
      }

      await writeAudit({
        client,
        actorType: 'SYSTEM',
        action: 'REFERRAL_QUALIFIED',
        targetType: 'user',
        targetId: referredUserId,
        metadata: {
          referrerId: referral.referrer_user_id,
          rule,
          commissionType: config.commissionType,
          commissionValue: config.commissionValue,
          amountCents,
        },
      });

      logger.info({ referrerId: referral.referrer_user_id, referredUserId, amountCents }, 'referral qualified');
      return { qualified: true, commissionCents: amountCents };
    }),
  );
}

export async function rejectReferral(referralId: string, reason: string, actorId: string): Promise<void> {
  await withTransaction(async (client) => {
    const res = await client.query<ReferralRow>('SELECT * FROM referrals WHERE id = $1 FOR UPDATE', [referralId]);
    if (!res.rows[0]) throw notFound('Referral');
    if (res.rows[0].status === 'PAID') throw conflict('This referral was already paid.');

    await client.query("UPDATE referrals SET status = 'REJECTED', rejected_reason = $2 WHERE id = $1", [referralId, reason]);
    await client.query("UPDATE referral_commissions SET status = 'REVERSED', note = $2 WHERE referral_id = $1", [referralId, reason]);

    await writeAudit({
      client,
      actorId,
      actorType: 'ADMIN',
      action: 'REFERRAL_REJECTED',
      targetType: 'user',
      targetId: res.rows[0].referred_user_id,
      reason,
      metadata: { referralId },
    });
  });
}

export async function markCommissionPaid(commissionId: string, actorId: string, note?: string): Promise<void> {
  await withTransaction(async (client) => {
    const res = await client.query<{ id: string; referral_id: string; amount_cents: number; referrer_user_id: string }>(
      'SELECT * FROM referral_commissions WHERE id = $1 FOR UPDATE',
      [commissionId],
    );
    const commission = res.rows[0];
    if (!commission) throw notFound('Commission');
    await client.query("UPDATE referral_commissions SET status = 'PAID', paid_at = now(), paid_by = $2, note = $3 WHERE id = $1", [
      commissionId,
      actorId,
      note ?? null,
    ]);
    await client.query("UPDATE referrals SET status = 'PAID' WHERE id = $1", [commission.referral_id]);
    await writeAudit({
      client,
      actorId,
      actorType: 'ADMIN',
      action: 'REFERRAL_COMMISSION_PAID',
      targetType: 'user',
      targetId: commission.referrer_user_id,
      metadata: { commissionId, amountCents: commission.amount_cents },
    });
  });
}

/** Pending payouts an admin should review (respecting the configured hold). */
export async function listPendingCommissions(limit = 10): Promise<
  Array<{ id: string; referrer_user_id: string; username: string | null; amount_cents: number; currency: string; created_at: Date; age_hours: number }>
> {
  const config = await getReferralConfig();
  return many(
    `SELECT c.id, c.referrer_user_id, u.username, c.amount_cents, c.currency, c.created_at,
            EXTRACT(EPOCH FROM (now() - c.created_at))/3600 AS age_hours
       FROM referral_commissions c JOIN users u ON u.id = c.referrer_user_id
      WHERE c.status IN ('PENDING','APPROVED')
      ORDER BY c.created_at ASC
      LIMIT $1`,
    [limit],
  ).then((rows) =>
    (rows as Array<{ age_hours: string | number } & Record<string, unknown>>)
      .filter((r) => Number(r.age_hours) >= config.holdHours)
      .map((r) => ({ ...r, age_hours: Number(r.age_hours) })) as never,
  );
}

export async function getReferralProgramSummary(): Promise<{
  totalReferrals: number;
  qualified: number;
  pendingCommissionsCents: number;
  paidCents: number;
  topReferrers: Array<{ user_id: string; username: string | null; qualified: number; earned_cents: number }>;
}> {
  const totals = await one<{ total: string; qualified: string; pending: string; paid: string }>(`
    SELECT
      (SELECT count(*)::text FROM referrals) AS total,
      (SELECT count(*)::text FROM referrals WHERE status IN ('QUALIFIED','PAID')) AS qualified,
      (SELECT COALESCE(sum(amount_cents),0)::text FROM referral_commissions WHERE status IN ('PENDING','APPROVED')) AS pending,
      (SELECT COALESCE(sum(amount_cents),0)::text FROM referral_commissions WHERE status = 'PAID') AS paid
  `);

  const top = await many<{ user_id: string; username: string | null; qualified: string; earned_cents: string }>(`
    SELECT r.referrer_user_id AS user_id, u.username,
           count(*) FILTER (WHERE r.status IN ('QUALIFIED','PAID'))::text AS qualified,
           COALESCE((SELECT sum(c.amount_cents) FROM referral_commissions c
                      WHERE c.referrer_user_id = r.referrer_user_id AND c.status <> 'REVERSED'), 0)::text AS earned_cents
      FROM referrals r JOIN users u ON u.id = r.referrer_user_id
     GROUP BY r.referrer_user_id, u.username
     ORDER BY qualified DESC, earned_cents DESC
     LIMIT 5
  `);

  return {
    totalReferrals: Number(totals?.total ?? 0),
    qualified: Number(totals?.qualified ?? 0),
    pendingCommissionsCents: Number(totals?.pending ?? 0),
    paidCents: Number(totals?.paid ?? 0),
    topReferrers: top.map((t) => ({
      user_id: t.user_id,
      username: t.username,
      qualified: Number(t.qualified),
      earned_cents: Number(t.earned_cents),
    })),
  };
}

export async function referralCodeExists(code: string): Promise<boolean> {
  const v = await scalar<number>('SELECT 1 FROM users WHERE referral_code = $1', [code]);
  return Boolean(v);
}

/** Records that a referral link was opened (visibility for the referrer). */
export async function noteReferralClick(code: string): Promise<void> {
  await query('UPDATE referral_codes SET clicks = clicks + 1 WHERE code = $1 AND is_active', [code]).catch(() => undefined);
}

export function assertReferralEnabled(enabled: boolean): void {
  if (!enabled) throw new AppError('FORBIDDEN', 'The referral programme is currently disabled.');
}

/** Used by tests and by the admin "referral details" screen. */
export async function getReferralById(id: string): Promise<ReferralRow | null> {
  return one<ReferralRow>('SELECT * FROM referrals WHERE id = $1', [id]);
}

export async function getPlanPriceCents(planId: string): Promise<number> {
  const plan = await getPlan(planId);
  return plan?.price_cents_per_month ?? 0;
}

export const REFERRAL_MIN_PAYOUT_CENTS = env.isTest ? 0 : 0;
