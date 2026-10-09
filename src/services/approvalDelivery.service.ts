/**
 * One-shot delivery of a user's SIP credentials on account approval.
 *
 * The format is the operator's (product) contract:
 *
 *   ✅ Your account has been approved!
 *   🔑 SIP ID: <extension>
 *   🔐 Password: <password>
 *   🌐 Host: <host>:<port>
 *   📅 Expires: <date>
 *   Use /start to access the bot.
 *
 * Security note (spec §33/§40 territory): the password is DELIVERED to its
 * owner - and only there. It is never logged and never written into the
 * notifications table (payload JSONB would persist it in the clear); its
 * canonical home stays the AES-256-GCM-encrypted sip_accounts row. Should the
 * one-shot delivery fail (chat blocked/deleted), the caller falls back to the
 * password-free USER_APPROVED notification and the user can re-open their
 * credentials in SIP Info at any time.
 */
import { logger } from '../lib/logger.js';
import { sipEndpointConfig } from './extension.service.js';

type DirectSend = (chatId: number, text: string) => Promise<unknown>;

let directSend: DirectSend | null = null;

/** Wired at process start (src/index.ts) with the bot's authenticated sender. */
export function setApprovalDeliverySender(fn: DirectSend | null): void {
  directSend = fn;
}

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export interface ApprovalCredentialsInput {
  telegramId: number;
  extension: string;
  password: string;
  expiresAt: Date | null;
}

/**
 * Sends the approval DM. Returns true on delivery; false (and logs, secret
 * free) when no sender is wired or Telegram refused the chat.
 */
export async function deliverApprovalCredentials(input: ApprovalCredentialsInput): Promise<boolean> {
  const { server, port } = sipEndpointConfig();
  const expires = input.expiresAt ? input.expiresAt.toISOString().slice(0, 10) : '—';

  const text = [
    '✅ <b>Your account has been approved!</b>',
    '',
    `🔑 SIP ID: <code>${esc(input.extension)}</code>`,
    `🔐 Password: <code>${esc(input.password)}</code>`,
    `🌐 Host: <code>${esc(`${server}:${port}`)}</code>`,
    `📅 Expires: ${expires}`,
    '',
    'Use /start to access the bot.',
  ].join('\n');

  if (!directSend) {
    logger.warn({ telegramId: input.telegramId }, 'no Telegram sender available for the approval DM');
    return false;
  }
  try {
    await directSend(input.telegramId, text);
    logger.info({ telegramId: input.telegramId, extension: input.extension }, 'approval credentials delivered');
    return true;
  } catch (err) {
    // Never log the rendered text: it contains the password.
    logger.warn({ telegramId: input.telegramId, err: (err as Error).message }, 'approval credentials delivery failed');
    return false;
  }
}
