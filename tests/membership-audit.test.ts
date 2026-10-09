import { beforeEach, describe, expect, it } from 'vitest';
import { many, one, query } from '../src/db/pool.js';
import {
  evaluateMembership,
  runMembershipSweep,
  type ParticipantFetcher,
} from '../src/services/membershipAudit.service.js';
import { createUser } from './helpers.js';

/**
 * Membership audit (operator order 2026-10-08): users must STAY joined. The
 * decision core is pure; the participant fetcher (GramJS in production) is
 * injected here, so these tests are deterministic and offline.
 */

const CHATS = [
  { chatId: '-1002066974831', title: 'AI Unbox — Channel', url: 'https://t.me/ai_unbox', kind: 'channel' },
  { chatId: '-1002205812723', title: 'AI Unbox — Group', url: 'https://t.me/+1LMI2ob9aHI3ZWQ9', kind: 'group' },
];

async function seedGate(on = true, chats: unknown = CHATS): Promise<void> {
  await query(
    `INSERT INTO admin_settings (key, value, value_type, category, label, description, is_editable) VALUES
       ('bot.require_channel_membership', $1::jsonb, 'boolean', 'bot', 'gate', 'test', true),
       ('bot.required_chats', $2::jsonb, 'json', 'bot', 'chats', 'test', true)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [JSON.stringify(on), JSON.stringify(chats)],
  );
}

async function account(tg: number, membershipOk: boolean | null): Promise<void> {
  await query('INSERT INTO telegram_accounts (telegram_id, membership_ok) VALUES ($1, $2)', [tg, membershipOk]);
}

describe('evaluateMembership (pure core)', () => {
  it('a user is compliant only while inside EVERY required chat', () => {
    const a = new Set([1, 2, 3]);
    const b = new Set([2, 4]);
    const decisions = evaluateMembership([a, b], [
      { telegramId: 1, membershipOk: true },   // in first only → left second
      { telegramId: 2, membershipOk: true },   // in both
      { telegramId: 3, membershipOk: false },  // in first only, already false
      { telegramId: 4, membershipOk: false },  // in second only
      { telegramId: 9, membershipOk: true },   // nowhere
    ]);
    const byId = new Map(decisions.map((d) => [d.telegramId, d]));
    expect(byId.get(2)).toEqual({ telegramId: 2, nowOk: true, changed: false });
    expect(byId.get(1)).toEqual({ telegramId: 1, nowOk: false, changed: true });
    expect(byId.get(9)).toEqual({ telegramId: 9, nowOk: false, changed: true });
    expect(byId.get(3)).toEqual({ telegramId: 3, nowOk: false, changed: false });
    expect(byId.get(4)).toEqual({ telegramId: 4, nowOk: false, changed: false });
    expect(decisions.filter((d) => d.changed)).toHaveLength(2);
  });
});

describe('runMembershipSweep (with stubbed fetcher)', () => {
  beforeEach(async () => {
    await seedGate();
  });

  it('marks accounts that left a required chat; idempotent on re-run', async () => {
    const u1 = await createUser({ telegramId: 910_100_001 });
    const u2 = await createUser({ telegramId: 910_200_002 });
    await account(u1.telegram_id, null); // freshly registered, flag unknown
    await account(u2.telegram_id, true);  // previously inside
    const participants: Record<string, Set<number>> = {
      '-1002066974831': new Set([u1.telegram_id, u2.telegram_id, 555]),
      '-1002205812723': new Set([u1.telegram_id, 555]), // u2 LEFT the group
    };
    const fetcher: ParticipantFetcher = async (chatId) => participants[chatId] ?? new Set();

    const first = await runMembershipSweep(fetcher);
    expect(first.skipped).toBe(false);
    expect(first.trackedAccounts).toBe(2);
    // u1: null->true (changed), u2: true->false (changed) => 2 updates, 1 non-compliant
    expect(first.updates).toBe(2);
    expect(first.nonCompliant).toBe(1);
    expect(first.perChatSize.map((c) => c.participants)).toEqual([3, 2]);

    const flags = await many<{ telegram_id: number; ok: boolean | null }>(
      'SELECT telegram_id, membership_ok::boolean AS ok FROM telegram_accounts ORDER BY telegram_id',
    );
    expect(flags.map((f) => [Number(f.telegram_id), f.ok])).toEqual([
      [u1.telegram_id, true],
      [u2.telegram_id, false],
    ]);

    // Operators are told ONCE per change, not every hour.
    const note = await one<{ c: string }>("SELECT count(*)::text AS c FROM notifications WHERE kind='ADMIN_ALERT'");
    expect(Number(note!.c)).toBe(1);
    const audit = await one<{ c: string }>("SELECT count(*)::text AS c FROM audit_logs WHERE action='MEMBERSHIP_SWEEP'");
    expect(Number(audit!.c)).toBe(1);

    const second = await runMembershipSweep(fetcher);
    expect(second.updates).toBe(0); // nothing changed -> silent
    const note2 = await one<{ c: string }>("SELECT count(*)::text AS c FROM notifications WHERE kind='ADMIN_ALERT'");
    expect(Number(note2!.c)).toBe(1);
  });

  it('aborts with ZERO writes when a chat cannot be enumerated (fail-closed)', async () => {
    const u = await createUser({ telegramId: 910_300_011 });
    await account(u.telegram_id, true);
    const fetcher: ParticipantFetcher = async (chatId) => {
      if (chatId === '-1002205812723') throw new Error('FLOOD_WAIT_3600');
      return new Set([u.telegram_id]);
    };
    await expect(runMembershipSweep(fetcher)).rejects.toThrow('FLOOD_WAIT');
    const flag = await one<{ ok: boolean | null }>(
      'SELECT membership_ok::boolean AS ok FROM telegram_accounts WHERE telegram_id=$1',
      [u.telegram_id],
    );
    expect(flag!.ok).toBe(true); // untouched
  });

  it('skips quietly: gate off, or no required chats', async () => {
    await seedGate(false);
    const off = await runMembershipSweep(async () => new Set());
    expect(off.skipped).toBe(true);

    await seedGate(true, []);
    const none = await runMembershipSweep(async () => new Set());
    expect(none.skipped).toBe(true);
  });
});
