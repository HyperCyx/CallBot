/**
 * MTProto user-app client (GramJS). Bot APIs cannot enumerate channel/group
 * members - only a logged-in user account can - so the membership sweep
 * (src/services/membershipAudit.service.ts) and the gate's second-opinion
 * check (src/userbot/memberOf.ts) go through this client.
 *
 * Credentials: TELEGRAM_API_ID / TELEGRAM_API_HASH (operator's my.telegram.org
 * app). The session is minted once by `scripts/userbot-login.ts` and stored in
 * admin_settings['userbot.session'] (not the .env file) so rotating it never
 * needs a redeploy. Everything using this module must handle
 * USERBOT_UNAVAILABLE - the sweep simply skips when no session exists.
 */
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { AppError } from '../lib/errors.js';
import { getRaw } from '../services/settings.service.js';

let client: TelegramClient | null = null;
let lastError: string | null = null;

export function userbotConfigured(): boolean {
  return env.userbot.apiId > 0 && env.userbot.apiHash.length > 0;
}

export function userbotLastError(): string | null {
  return lastError;
}

export async function getUserbot(): Promise<TelegramClient> {
  if (client?.connected) return client;
  if (!userbotConfigured()) throw new AppError('USERBOT_UNAVAILABLE', 'TELEGRAM_API_ID/HASH not configured');
  const session = await getRaw('userbot.session', '');
  if (typeof session !== 'string' || session.length === 0) {
    throw new AppError(
      'USERBOT_UNAVAILABLE',
      'No userbot session yet - run `npx tsx scripts/userbot-login.ts send <phone>` once (operator).',
    );
  }
  try {
    client = new TelegramClient(new StringSession(session), env.userbot.apiId, env.userbot.apiHash, {
      connectionRetries: 5,
      retryDelay: 3000,
      autoReconnect: true,
    });
    await client.connect();
    lastError = null;
    logger.info('userbot session connected');
    return client;
  } catch (err) {
    lastError = (err as Error).message;
    client = null;
    throw new AppError('USERBOT_UNAVAILABLE', `userbot session failed: ${lastError}`);
  }
}

/** Only for the login script and tests. */
export function resetUserbotForTests(): void {
  client = null;
  lastError = null;
}
