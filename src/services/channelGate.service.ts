/**
 * Forced channel/group membership (operator order 2026-10-08):
 * every applicant must join ALL required chats BEFORE the captcha, and a
 * deleted user who comes back must pass the gate again like a fresh start.
 *
 * Required chats are DB-driven (`bot.required_chats`, seeded by migration 018
 * with the operator's channel + group) so the admin can change them without a
 * redeploy; the single old env var TELEGRAM_REQUIRED_CHANNEL still works as a
 * fallback when the DB list is empty.
 *
 * Fail-open on Telegram API errors (bot not admin in the chat, wrong id, API
 * hiccup): users keep flowing, but operators get an ADMIN_ALERT once so the
 * misconfiguration is surfaced instead of silently disabling the gate.
 */
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { getRaw } from './settings.service.js';
import { enqueueAdminNotification } from './notification.service.js';

export interface RequiredChat {
  /** Numeric chat id ('-100…') or '@username' — anything getChatMember accepts. */
  chatId: string;
  title: string;
  /** Join link shown on the gate screen (private invite link for groups). */
  url: string;
  kind: 'channel' | 'group';
}

export async function getRequiredChats(): Promise<RequiredChat[]> {
  const raw = await getRaw('bot.required_chats', null);
  if (Array.isArray(raw)) {
    const list = raw
      .map((item): RequiredChat | null => {
        if (!item || typeof item !== 'object') return null;
        const c = item as Record<string, unknown>;
        const chatId = String(c.chatId ?? c.chat_id ?? '').trim();
        if (!chatId) return null;
        return {
          chatId,
          title: String(c.title ?? chatId),
          url: String(c.url ?? ''),
          kind: c.kind === 'group' ? 'group' : 'channel',
        };
      })
      .filter((c): c is RequiredChat => c !== null);
    if (list.length > 0) return list;
  }
  // Back-compat fallback: the pre-migration single-channel env var.
  const legacy = env.TELEGRAM_REQUIRED_CHANNEL?.trim();
  if (legacy) {
    return [{ chatId: legacy, title: legacy, url: `https://t.me/${legacy.replace(/^@/, '')}`, kind: 'channel' }];
  }
  return [];
}

export function normalizeMemberStatus(status: string, isMember?: boolean | null): 'ok' | 'missing' {
  if (status === 'creator' || status === 'administrator' || status === 'member') return 'ok';
  // Restricted users count only while they are still inside the chat.
  if (status === 'restricted') return isMember === false ? 'missing' : 'ok';
  return 'missing'; // left / kicked / unknown
}

export interface MembershipCheckResult {
  ok: boolean;
  missing: RequiredChat[];
}

/** Minimal API surface so tests can stub it without a live Bot/grammY context. */
export interface ChatMemberApi {
  getChatMember(chatId: string | number, userId: number): Promise<{ status: string; is_member?: boolean }>;
}

/** Second-opinion checker (MTProto userbot in production, stub in tests). */
export type FallbackMemberChecker = (chatId: string, userId: number) => Promise<'ok' | 'missing'>;

async function userbotFallbackChecker(chatId: string, userId: number): Promise<'ok' | 'missing'> {
  // Dynamic import: GramJS must never load on this path when unconfigured.
  const { memberOfViaUserbot } = await import('../userbot/memberOf.js');
  return memberOfViaUserbot(chatId, userId);
}

export async function checkRequiredMembership(
  api: ChatMemberApi,
  userId: number,
  fallback: FallbackMemberChecker = userbotFallbackChecker,
): Promise<MembershipCheckResult> {
  const chats = await getRequiredChats();
  const missing: RequiredChat[] = [];
  for (const chat of chats) {
    try {
      const member = await api.getChatMember(chat.chatId, userId);
      if (normalizeMemberStatus(member.status, member.is_member) === 'missing') missing.push(chat);
      continue;
    } catch (err) {
      logger.warn({ err: (err as Error).message, chatId: chat.chatId }, 'Bot API membership check failed; asking the userbot (MTProto) for a second opinion');
    }

    // Bot API errored -> dual-source check via MTProto (operator's api_id/hash).
    // Verified verdicts replace the old blind fail-open: "definitely inside" =
    // ok, "definitely not inside" = gate. Only when BOTH sources fail do we
    // fail open and alert the operators.
    try {
      const verdict = await fallback(chat.chatId, userId);
      if (verdict === 'missing') missing.push(chat);
      continue;
    } catch (fallbackErr) {
      const fallbackMessage = (fallbackErr as Error).message;
      logger.warn({ err: fallbackMessage, chatId: chat.chatId }, 'userbot membership check also failed; failing open');
      enqueueAdminNotification(
        'ADMIN_ALERT',
        {
          title: 'Membership check broken',
          message:
            `Could not verify membership for ${chat.title} (<code>${chat.chatId}</code>) via Bot API or userbot: ${fallbackMessage}. ` +
            `The bot must be an ADMIN of the ${chat.kind}; the userbot session must be live (scripts/userbot-login.ts).`,
        },
        `chatchk:${chat.chatId}`,
      ).catch(() => undefined);
    }
  }
  return { ok: missing.length === 0, missing };
}
