import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { one, query } from '../src/db/pool.js';
import {
  checkRequiredMembership,
  getRequiredChats,
  normalizeMemberStatus,
  type ChatMemberApi,
} from '../src/services/channelGate.service.js';
import { deleteUserAccount } from '../src/services/userDeletion.service.js';
import { assignNumber, releaseNumber } from '../src/services/assignment.service.js';
import { addNumbersToInventory, auditActions, createSipAccount, createUser, getCountryId, getNumberRow, getServiceId, mockPbx } from './helpers.js';

/**
 * Operator orders 2026-10-08:
 *  1. Forced membership gate over BOTH operator chats (channel + group),
 *     checked live before registration.
 *  2. Admin deletion = full purge. A deleted user who sends /start must see
 *     the captcha again - the bot_sessions row used to survive and skip it
 *     (the live bug "the capture is not being shown to him").
 *  3. Every user-owned row disappears; history rows keep life with nulled refs.
 */

describe('membership gate - normalizeMemberStatus', () => {
  it('accepts live members and rejects everyone else', () => {
    expect(normalizeMemberStatus('creator')).toBe('ok');
    expect(normalizeMemberStatus('administrator')).toBe('ok');
    expect(normalizeMemberStatus('member')).toBe('ok');
    expect(normalizeMemberStatus('restricted', true)).toBe('ok');
    expect(normalizeMemberStatus('restricted', false)).toBe('missing');
    expect(normalizeMemberStatus('restricted')).toBe('ok');
    expect(normalizeMemberStatus('left')).toBe('missing');
    expect(normalizeMemberStatus('kicked')).toBe('missing');
    expect(normalizeMemberStatus('whatever-new-tg-status')).toBe('missing');
  });
});

/** The test harness truncates admin_settings between tests; reseed the
 *  operator chats exactly as migration 018 does in production. */
const OPERATOR_CHATS = [
  { chatId: '-1002066974831', title: 'AI Unbox — Channel', url: 'https://t.me/ai_unbox', kind: 'channel' },
  { chatId: '-1002205812723', title: 'AI Unbox — Group', url: 'https://t.me/+1LMI2ob9aHI3ZWQ9', kind: 'group' },
];

describe('membership gate - DB-driven required chats', () => {
  beforeEach(async () => {
    await query(
      `INSERT INTO admin_settings (key, value, value_type, category, label, description, is_editable)
       VALUES ('bot.required_chats', $1::jsonb, 'json', 'bot', 'Required chats to join', 'test seed', true)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [JSON.stringify(OPERATOR_CHATS)],
    );
  });

  it('parses the two operator chats from admin_settings', async () => {
    const chats = await getRequiredChats();
    const byId = new Map(chats.map((c) => [c.chatId, c]));
    expect(chats).toHaveLength(2);
    expect(byId.get('-1002066974831')?.url).toBe('https://t.me/ai_unbox');
    expect(byId.get('-1002066974831')?.kind).toBe('channel');
    expect(byId.get('-1002205812723')?.url).toBe('https://t.me/+1LMI2ob9aHI3ZWQ9');
    expect(byId.get('-1002205812723')?.kind).toBe('group');
  });

  it('checkRequiredMembership: ALL chats must be joined', async () => {
    const member: ChatMemberApi = { getChatMember: async () => ({ status: 'member' }) };
    expect(await checkRequiredMembership(member, 1)).toEqual({ ok: true, missing: [] });

    const halfJoined: ChatMemberApi = {
      getChatMember: async (chatId) => ({ status: String(chatId) === '-1002205812723' ? 'left' : 'member' }),
    };
    const half = await checkRequiredMembership(halfJoined, 1);
    expect(half.ok).toBe(false);
    expect(half.missing.map((c) => c.chatId)).toEqual(['-1002205812723']);
  });

  it('dual-source: Bot API errors fall back to the MTProto userbot verdict', async () => {
    const brokenBotApi: ChatMemberApi = {
      getChatMember: async () => {
        throw new Error('Bad Request: chat not found');
      },
    };
    // userbot confirms the user IS inside -> gate passes (no blind fail-open needed).
    const insideViaUserbot = await checkRequiredMembership(brokenBotApi, 1, async () => 'ok');
    expect(insideViaUserbot.ok).toBe(true);
    expect(insideViaUserbot.missing).toEqual([]);

    // userbot confirms the user is NOT inside -> gate enforced even though Bot API is broken.
    const outsideViaUserbot = await checkRequiredMembership(brokenBotApi, 1, async () => 'missing');
    expect(outsideViaUserbot.ok).toBe(false);
    expect(outsideViaUserbot.missing.map((c) => c.chatId).sort()).toEqual(['-1002066974831', '-1002205812723']);

    // BOTH sources fail -> the old fail-open safety net still applies, and the alert fires.
    const bothBroken = await checkRequiredMembership(brokenBotApi, 1, async () => {
      throw new Error('USERBOT_UNAVAILABLE: no session');
    });
    expect(bothBroken.ok).toBe(true);
    expect(bothBroken.missing).toEqual([]);
  });
});

describe('account deletion - full purge (operator order)', () => {
  beforeAll(() => {
    mockPbx();
  });

  it('removes the user data from every table and frees their number', async () => {
    const tg = 710_000_001;
    const user = await createUser({ telegramId: tg, username: 'petertest' });
    const actor = await createUser({ telegramId: 820_000_002, username: 'adminactor', status: 'ACTIVE' });
    await createSipAccount(user.id, '20111');

    // Seed every kind of user-owned row.
    await query('INSERT INTO wallets (user_id) VALUES ($1)', [user.id]);
    await query(
      "INSERT INTO wallet_transactions (wallet_user_id, kind, amount_cents, balance_after_cents) VALUES ($1,'DEPOSIT',500,500)",
      [user.id],
    );
    await query("INSERT INTO referral_codes (code, user_id) VALUES ('PETE777', $1)", [user.id]);
    await query("INSERT INTO deposit_requests (user_id, amount_cents, status) VALUES ($1, 900, 'PENDING')", [user.id]);
    await query(
      "INSERT INTO notifications (kind, user_id, payload, status) VALUES ('GENERAL',$1,'{}'::jsonb,'PENDING')",
      [user.id],
    );
    await query(
      'INSERT INTO telegram_accounts (telegram_id, user_id, username) VALUES ($1,$2,$3) ON CONFLICT (telegram_id) DO UPDATE SET user_id=$2',
      [tg, user.id, 'petertest'],
    );
    // The smoking gun of the live bug: a session carrying captchaPassed=true.
    await query(
      "INSERT INTO bot_sessions (key, value, updated_at) VALUES ($1, '{\"captchaPassed\":true}'::jsonb, now()) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value",
      [`${tg}:${tg}`],
    );
    // A number bound to the account (goes through the real assignment path).
    const countryId = await getCountryId();
    const serviceId = await getServiceId();
    await addNumbersToInventory({ count: 1, countryId, serviceId, planType: 'FREE' });
    const assignment = await assignNumber({ userId: user.id, countryId, serviceId });
    const numberId = assignment.numberId;

    // History rows that must survive with nulled references.
    await query('UPDATE users SET approved_by=$2 WHERE id=$1', [user.id, actor.id]);
    await query(
      "INSERT INTO audit_logs (actor_id, actor_type, action, target_type, target_id, result) VALUES ($1,'ADMIN','APPROVE','user',$2,'SUCCESS')",
      [actor.id, user.id],
    );

    const result = await deleteUserAccount(user.id, { actorId: actor.id, reason: 'test purge' });
    expect(result.releasedNumbers).toBe(1);
    expect(result.purgedRows).toBeGreaterThan(5);

    // Every user-owned row is GONE.
    const tables: Array<[string, string, unknown[]]> = [
      ['telegram_accounts', 'telegram_id=$1', [tg]],
      ['wallets', 'user_id=$1', [user.id]],
      ['wallet_transactions', 'wallet_user_id=$1', [user.id]],
      ['referral_codes', 'user_id=$1', [user.id]],
      ['deposit_requests', 'user_id=$1', [user.id]],
      ['notifications', 'user_id=$1', [user.id]],
      ['sip_accounts', 'user_id=$1', [user.id]],
      ['number_assignments', 'user_id=$1', [user.id]],
      ['user_roles', 'user_id=$1', [user.id]],
      ['extension_allocations', 'user_id=$1', [user.id]],
      ['call_history', 'user_id=$1', [user.id]],
    ];
    for (const [table, where, params] of tables) {
      const row = await one<{ c: string }>(`SELECT count(*)::text AS c FROM ${table} WHERE ${where}`, params);
      expect(Number(row!.c), `${table} must be empty after purge`).toBe(0);
    }

    // The stale session - root cause of the captcha bug - is gone too. After
    // the purge a fresh /start reads NO session, so captchaPassed is never
    // inherited (the flow also force-resets the flag for unknown users).
    const sess = await one<{ c: string }>('SELECT count(*)::text AS c FROM bot_sessions WHERE key LIKE $1', [`%:${tg}`]);
    expect(Number(sess!.c)).toBe(0);

    // The number is back in inventory and unassigned.
    const num = await getNumberRow(numberId);
    expect(num).toBeTruthy();
    expect(num!.assigned_user_id).toBeNull();
    expect(['AVAILABLE', 'RETIRED']).toContain(num!.status);

    // The users row survives only as an anonymized tombstone: the immutable
    // audit trail (DB triggers, §28) references it, so a physical delete is
    // impossible by design. Every identifying field is gone.
    const shell = await one<{
      telegram_id: number | null; username: string | null; referral_code: string | null;
      status: string; deleted_at: Date | null; display_name: string | null; plan_id: string | null;
    }>('SELECT telegram_id, username, referral_code, status, deleted_at, display_name, plan_id FROM users WHERE id=$1', [user.id]);
    expect(shell).toBeTruthy();
    expect(shell!.status).toBe('DELETED');
    expect(shell!.deleted_at).not.toBeNull();
    expect(shell!.telegram_id).toBeNull();
    expect(shell!.username).toBeNull();
    expect(shell!.display_name).toBeNull();
    expect(shell!.referral_code).toBeNull();
    expect(shell!.plan_id).toBeNull();

    // History survives: actor user untouched, and the purge itself is audited.
    const otherUser = await one<{ approved_by: string | null }>('SELECT approved_by FROM users WHERE id=$1', [actor.id]);
    expect(otherUser).toBeTruthy();
    const actions = await auditActions();
    expect(actions).toContain('USER_PURGED');
  });

  it('a deleted user re-registers as a BRAND NEW account (fresh uuid, zero carried data)', async () => {
    const tg = 710_000_100;
    const user = await createUser({ telegramId: tg, username: 'comeback2', status: 'ACTIVE' });
    const actor = await createUser({ telegramId: 820_000_101, username: 'adminx2' });
    await deleteUserAccount(user.id, { actorId: actor.id });

    const { registerUser } = await import('../src/services/user.service.js');
    const again = await registerUser({ telegramId: tg, username: 'comeback2' });
    expect(again.created).toBe(true);
    expect(again.user.id).not.toBe(user.id); // new identity, nothing inherited
    expect(again.user.status).toBe('PENDING');
  });

  it('a second deletion throws (no live account to purge)', async () => {
    const user = await createUser({ telegramId: 710_000_030, username: 'goneuser' });
    const actor = await createUser({ telegramId: 820_000_031, username: 'gadmir' });
    await deleteUserAccount(user.id, { actorId: actor.id });
    await expect(deleteUserAccount(user.id, { actorId: actor.id })).rejects.toThrow();
  });
});
