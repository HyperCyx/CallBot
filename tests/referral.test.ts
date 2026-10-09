import { describe, expect, it } from 'vitest';
import { one, query } from '../src/db/pool.js';
import { registerUser } from '../src/services/user.service.js';
import { setSetting } from '../src/services/settings.service.js';
import {
  evaluateReferralQualification,
  getReferralProgramSummary,
  getReferralStats,
  listPendingCommissions,
  markCommissionPaid,
  rejectReferral,
} from '../src/services/referral.service.js';
import { auditActions, createUser } from './helpers.js';

/**
 * Referral system (spec §23).
 *
 * The money-critical invariants are: one referrer per user, credited once at
 * registration (the only moment the attribution is trustworthy), self-referrals
 * refused, and the commission rate snapshotted so later config changes cannot
 * rewrite history.
 */

const BOT = 'SipBotTestBot';

async function codeOf(userId: string): Promise<string> {
  const row = await one<{ referral_code: string }>('SELECT referral_code FROM users WHERE id = $1', [userId]);
  return row!.referral_code;
}

async function referralRow(referredUserId: string) {
  return one<{ id: string; referrer_user_id: string; status: string; qualification_rule: string | null; qualified_at: Date | null }>(
    'SELECT id, referrer_user_id, status, qualification_rule, qualified_at FROM referrals WHERE referred_user_id = $1',
    [referredUserId],
  );
}

describe('referral attribution (spec §23)', () => {
  it('credits the referrer once, at registration', async () => {
    const referrer = await createUser({ telegramId: 900001 });
    const code = await codeOf(referrer.id);

    const { user, created } = await registerUser({
      telegramId: 900002,
      username: 'invited',
      displayName: 'Invited User',
      referralCodeFromStart: code,
    });
    expect(created).toBe(true);

    const referral = await referralRow(user.id);
    expect(referral?.referrer_user_id).toBe(referrer.id);
    expect(referral?.status).toBe('PENDING');

    const stats = await getReferralStats(referrer.id, BOT);
    expect(stats.total).toBe(1);
    expect(stats.pending).toBe(1);
    expect(stats.link).toBe(`https://t.me/${BOT}?start=${code}`);
  });

  it('never re-attributes an existing user to a second referrer', async () => {
    const first = await createUser({ telegramId: 900010 });
    const second = await createUser({ telegramId: 900011 });

    const { user } = await registerUser({ telegramId: 900012, referralCodeFromStart: await codeOf(first.id) });
    // Same Telegram account comes back through a different referral link.
    const again = await registerUser({ telegramId: 900012, referralCodeFromStart: await codeOf(second.id) });

    expect(again.created).toBe(false);
    expect(again.user.id).toBe(user.id);
    const count = await one<{ count: string }>('SELECT count(*)::text AS count FROM referrals');
    expect(Number(count?.count)).toBe(1);
    expect((await referralRow(user.id))?.referrer_user_id).toBe(first.id);
  });

  it('refuses a referral code that belongs to a deleted account', async () => {
    const gone = await createUser({ telegramId: 900020 });
    const code = await codeOf(gone.id);
    await query("UPDATE users SET status = 'DELETED', deleted_at = now() WHERE id = $1", [gone.id]);

    const { user: newcomer } = await registerUser({ telegramId: 900021, referralCodeFromStart: code });
    const me = await one<{ referred_by: string | null }>('SELECT referred_by FROM users WHERE id = $1', [newcomer.id]);
    expect(me?.referred_by).toBeNull();
    expect(await referralRow(newcomer.id)).toBeNull();
  });

  it('ignores an unknown referral code instead of failing the registration', async () => {
    const { user: user } = await registerUser({ telegramId: 900022, referralCodeFromStart: 'NOSUCHCODE' });
    expect(user.status).toBe('PENDING');
    expect(await referralRow(user.id)).toBeNull();
    // The user still gets their own code to share.
    expect(await codeOf(user.id)).toMatch(/^[A-Z0-9]+$/);
  });

  it('enforces the anti-abuse invariants in the database too', async () => {
    const a = await createUser({ telegramId: 900030 });
    const b = await createUser({ telegramId: 900031 });

    // Self-referral: CHECK constraint.
    await expect(
      query(
        `INSERT INTO referrals (referrer_user_id, referred_user_id, referral_code) VALUES ($1,$1,'SELF')`,
        [a.id],
      ),
    ).rejects.toThrow(/referrals_no_self/);

    // Duplicate credit for the same user: UNIQUE constraint.
    await query(`INSERT INTO referrals (referrer_user_id, referred_user_id, referral_code) VALUES ($1,$2,'X')`, [a.id, b.id]);
    await expect(
      query(`INSERT INTO referrals (referrer_user_id, referred_user_id, referral_code) VALUES ($1,$2,'Y')`, [b.id, b.id]),
    ).rejects.toThrow();
  });
});

describe('referral qualification and commission (spec §23)', () => {
  async function setupReferral(opts: { rule?: string; type?: string; value?: number } = {}) {
    await setSetting('referral.qualification_rule', opts.rule ?? 'FIRST_NUMBER_ASSIGNED');
    await setSetting('referral.commission_type', opts.type ?? 'PERCENTAGE');
    await setSetting('referral.commission_value', opts.value ?? 20);
    await setSetting('referral.max_per_referrer_per_day', 20);

    const referrer = await createUser({ telegramId: 901000 });
    const { user: referred } = await registerUser({
      telegramId: 901001,
      referralCodeFromStart: await codeOf(referrer.id),
    });
    return { referrer, referred };
  }

  it('does not qualify before the configured rule fires', async () => {
    const { referred } = await setupReferral({ rule: 'FIRST_NUMBER_ASSIGNED' });
    // Captcha passed / account created is NOT qualification for this rule.
    const early = await evaluateReferralQualification(referred.id, 'SIGNUP');
    expect(early.qualified).toBe(false);
    expect((await referralRow(referred.id))?.status).toBe('PENDING');
  });

  it('qualifies on the rule and snapshots rate, base amount and currency', async () => {
    const { referrer, referred } = await setupReferral({ rule: 'FIRST_NUMBER_ASSIGNED', type: 'PERCENTAGE', value: 20 });
    // Premium plan is 999 cents/month -> 20% = 199.8 -> 200 cents (rounded).
    await query("UPDATE users SET plan_id = (SELECT id FROM plans WHERE code = 'premium') WHERE id = $1", [referred.id]);

    const result = await evaluateReferralQualification(referred.id, 'FIRST_NUMBER_ASSIGNED');
    expect(result.qualified).toBe(true);

    const referral = await referralRow(referred.id);
    expect(referral?.status).toBe('QUALIFIED');
    expect(referral?.qualification_rule).toBe('FIRST_NUMBER_ASSIGNED');
    expect(referral?.qualified_at).toBeInstanceOf(Date);

    const commission = await one<{ amount_cents: number; commission_type: string; rate_value: string; base_amount_cents: number; currency: string; status: string }>(
      'SELECT amount_cents, commission_type, rate_value, base_amount_cents, currency, status FROM referral_commissions WHERE referral_id = $1',
      [referral!.id],
    );
    expect(commission?.amount_cents).toBe(200);
    expect(commission?.commission_type).toBe('PERCENTAGE');
    expect(Number(commission?.rate_value)).toBe(20);
    expect(commission?.base_amount_cents).toBe(999);
    expect(commission?.currency).toBe('EUR');
    expect(commission?.status).toBe('PENDING');

    // Config changes afterwards must not rewrite the historical commission.
    await setSetting('referral.commission_value', 99);
    const stored = await one<{ amount_cents: number; rate_value: string }>(
      'SELECT amount_cents, rate_value FROM referral_commissions WHERE referral_id = $1',
      [referral!.id],
    );
    expect(stored?.amount_cents).toBe(200);
    expect(Number(stored?.rate_value)).toBe(20);

    // Idempotent: a second trigger does not create a second commission.
    await evaluateReferralQualification(referred.id, 'FIRST_NUMBER_ASSIGNED');
    const commissionCount = await one<{ count: string }>('SELECT count(*)::text AS count FROM referral_commissions');
    expect(Number(commissionCount?.count)).toBe(1);

    const stats = await getReferralStats(referrer.id, BOT);
    expect(stats.qualified).toBe(1);
    expect(stats.pendingCents).toBe(200);
  });

  it('supports a fixed commission regardless of plan price', async () => {
    const { referred } = await setupReferral({ rule: 'SIGNUP', type: 'FIXED', value: 2.5 });
    const result = await evaluateReferralQualification(referred.id, 'SIGNUP');
    expect(result.qualified).toBe(true);
    expect(result.commissionCents).toBe(250);
  });

  it('stops paying once the daily cap for a referrer is reached', async () => {
    const referrer = await createUser({ telegramId: 901100 });
    const code = await codeOf(referrer.id);
    await setSetting('referral.qualification_rule', 'SIGNUP');
    await setSetting('referral.commission_type', 'FIXED');
    await setSetting('referral.commission_value', 5);
    await setSetting('referral.max_per_referrer_per_day', 1);

    const first = await registerUser({ telegramId: 901101, referralCodeFromStart: code });
    const second = await registerUser({ telegramId: 901102, referralCodeFromStart: code });

    expect((await evaluateReferralQualification(first.user.id, 'SIGNUP')).qualified).toBe(true);
    expect((await evaluateReferralQualification(second.user.id, 'SIGNUP')).qualified).toBe(false);
    expect((await referralRow(second.user.id))?.status).toBe('PENDING');
    expect(await auditActions()).toContain('REFERRAL_REJECTED');
  });

  it('pays nothing while the programme is disabled', async () => {
    const { referred } = await setupReferral({ rule: 'SIGNUP' });
    await setSetting('referral.enabled', false);
    expect((await evaluateReferralQualification(referred.id, 'SIGNUP')).qualified).toBe(false);
    const stats = await getReferralStats(referred.id, BOT);
    expect(stats.enabled).toBe(false);
  });

  it('lets an admin reject a suspicious referral, permanently', async () => {
    const { referred } = await setupReferral({ rule: 'SIGNUP' });
    const referral = await referralRow(referred.id);
    const admin = await createUser({ telegramId: 901200 });

    await rejectReferral(referral!.id, 'duplicate device fingerprint', admin.id);
    expect((await referralRow(referred.id))?.status).toBe('REJECTED');
    expect(await auditActions()).toContain('REFERRAL_REJECTED');

    // A rejected referral can never become payable later.
    expect((await evaluateReferralQualification(referred.id, 'SIGNUP')).qualified).toBe(false);
    const commissionCount = await one<{ count: string }>('SELECT count(*)::text AS count FROM referral_commissions');
    expect(Number(commissionCount?.count)).toBe(0);
  });
});

describe('referral payouts (spec §23)', () => {
  it('marks a commission paid, moves the referral to PAID and audits it', async () => {
    await setSetting('referral.qualification_rule', 'SIGNUP');
    await setSetting('referral.commission_type', 'FIXED');
    await setSetting('referral.commission_value', 5);
    await setSetting('referral.hold_hours', 0);

    const referrer = await createUser({ telegramId: 902000 });
    const { user: referred } = await registerUser({ telegramId: 902001, referralCodeFromStart: await codeOf(referrer.id) });
    const admin = await createUser({ telegramId: 902002 });
    await evaluateReferralQualification(referred.id, 'SIGNUP');

    const pending = await listPendingCommissions(10);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.amount_cents).toBe(500);
    expect(pending[0]?.username).toBeTruthy();

    await markCommissionPaid(pending[0]!.id, admin.id, 'paid via bank transfer');
    expect(await auditActions()).toContain('REFERRAL_COMMISSION_PAID');

    const stats = await getReferralStats(referrer.id, BOT);
    expect(stats.pendingCents).toBe(0);
    expect(stats.paidCents).toBe(500);
    expect((await referralRow(referred.id))?.status).toBe('PAID');
    expect(await listPendingCommissions(10)).toHaveLength(0);

    const summary = await getReferralProgramSummary();
    expect(summary.totalReferrals).toBe(1);
    expect(summary.qualified).toBe(1);
    expect(summary.paidCents).toBe(500);
    expect(summary.topReferrers[0]?.user_id).toBe(referrer.id);
  });
});
