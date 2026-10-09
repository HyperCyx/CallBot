/**
 * Membership audit (operator order 2026-10-08): not only must an applicant
 * pass the channel/group gate at registration - they must STAY joined. Bot
 * API can't enumerate members, so a userbot (MTProto, operator's
 * my.telegram.org app) sweeps every required chat hourly and flips
 * telegram_accounts.membership_ok=false for accounts no longer inside.
 *
 * Failure policy: if ANY chat cannot be enumerated (session expired, flood
 * wait, rights lost) the whole sweep aborts with zero writes - a partial
 * listing must never mark thousands of accounts "left" by mistake.
 *
 * The pure decision core (evaluateMembership) is exported for unit tests; the
 * participant fetcher is injected, so GramJS never loads under vitest.
 */
import { many, query } from '../db/pool.js';
import { logger } from '../lib/logger.js';
import { getBool } from './settings.service.js';
import { getRequiredChats, type RequiredChat } from './channelGate.service.js';
import { setMembershipStatus } from './user.service.js';
import { enqueueAdminNotification } from './notification.service.js';

export interface TrackedAccount {
  telegramId: number;
  membershipOk: boolean;
}

export interface MembershipDecision {
  telegramId: number;
  nowOk: boolean;
  changed: boolean;
}

/** A user is compliant only while inside EVERY required chat. */
export function evaluateMembership(participantSets: ReadonlyArray<ReadonlySet<number>>, tracked: TrackedAccount[]): MembershipDecision[] {
  return tracked.map(({ telegramId, membershipOk }) => {
    const nowOk = participantSets.every((set) => set.has(telegramId));
    return { telegramId, nowOk, changed: nowOk !== membershipOk };
  });
}

export interface SweepSummary {
  skipped: boolean;
  reason?: string;
  chats: number;
  trackedAccounts: number;
  updates: number;
  /** Accounts that are not in at least one required chat after the sweep. */
  nonCompliant: number;
  perChatSize: Array<{ chatId: string; title: string; participants: number }>;
}

export interface ParticipantFetcher {
  (chatId: string): Promise<Set<number>>;
}

export async function runMembershipSweep(fetchParticipants: ParticipantFetcher): Promise<SweepSummary> {
  const required = await getBool('bot.require_channel_membership', false);
  if (!required) return { skipped: true, reason: 'membership gate is off', chats: 0, trackedAccounts: 0, updates: 0, nonCompliant: 0, perChatSize: [] };

  const chats: RequiredChat[] = await getRequiredChats();
  if (chats.length === 0) return { skipped: true, reason: 'no required chats configured', chats: 0, trackedAccounts: 0, updates: 0, nonCompliant: 0, perChatSize: [] };

  // Enumerate ALL chats first; any failure aborts with no writes (fail-closed).
  const sets = await Promise.all(chats.map((c) => fetchParticipants(c.chatId)));

  const tracked = await many<{ telegram_id: string | number; membership_ok: boolean | null }>(
    'SELECT telegram_id, membership_ok FROM telegram_accounts WHERE banned = false',
  );
  const decisions = evaluateMembership(
    sets,
    tracked.map((r) => ({ telegramId: Number(r.telegram_id), membershipOk: r.membership_ok === true })),
  );

  let updates = 0;
  for (const d of decisions) {
    if (!d.changed) continue;
    await setMembershipStatus(d.telegramId, d.nowOk);
    updates += 1;
  }
  const nonCompliant = decisions.filter((d) => !d.nowOk).length;
  const summary: SweepSummary = {
    skipped: false,
    chats: chats.length,
    trackedAccounts: tracked.length,
    updates,
    nonCompliant,
    perChatSize: chats.map((c, i) => ({ chatId: c.chatId, title: c.title, participants: sets[i]?.size ?? 0 })),
  };
  logger.info(summary, 'membership sweep complete');

  if (updates > 0) {
    await query(
      `INSERT INTO audit_logs (actor_type, action, target_type, result, metadata)
       VALUES ('SYSTEM','MEMBERSHIP_SWEEP','system','SUCCESS',$1::jsonb)`,
      [JSON.stringify({ updates, nonCompliant, perChatSize: summary.perChatSize })],
    ).catch((err) => logger.warn({ err: (err as Error).message }, 'sweep audit write failed'));
    await enqueueAdminNotification('ADMIN_ALERT', {
      title: 'Membership sweep',
      message:
        `⚠️ ${updates} account(s) lost membership of a required chat (now non-compliant: ${nonCompliant}). ` +
        `They fail the gate again on their next /start.`,
    }).catch(() => undefined);
  }
  return summary;
}
