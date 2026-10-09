import type { StorageAdapter } from 'grammy';
import { query } from '../db/pool.js';
import { logger } from '../lib/logger.js';

/**
 * Conversation state for the bot.
 *
 * Persisted in PostgreSQL rather than memory so that:
 *   * a restart or deploy does not lose a half-finished admin flow (e.g. an
 *     admin halfway through importing a CSV),
 *   * several bot instances can share the same state,
 *   * callback data can stay small (Telegram limits it to 64 bytes) because
 *     multi-step flows are keyed by session instead of by packed payloads.
 */

export interface SessionData {
  /** Current multi-step input, if any. */
  step?:
    | { type: 'captcha'; expected: number; attempts: number; referralCode?: string | null }
    | { type: 'admin_add_country' }
    | { type: 'admin_add_service' }
    | { type: 'admin_add_numbers'; countryId: string; serviceId: string; planType: 'FREE' | 'PREMIUM' }
    | { type: 'admin_csv_import'; countryId: string; serviceId: string; planType: 'FREE' | 'PREMIUM' }
    | { type: 'admin_search_user' }
    | { type: 'admin_broadcast' }
    | { type: 'support_message' }
    | { type: 'admin_set_setting'; key: string; label: string }
    | { type: 'admin_edit_country'; countryId: string; field: 'name' | 'flag' | 'dial_code' }
    | { type: 'admin_edit_service'; serviceId: string; field: 'name' | 'icon' | 'description' }
    | { type: 'deposit_amount'; methodId: string }
    | { type: 'deposit_note'; methodId: string; amountCents: number }
    | { type: 'admin_fund_amount'; targetUserId: string }
    | { type: 'admin_pm_add_name' }
    | { type: 'admin_pm_add_address'; name: string }
    | { type: 'admin_pm_edit_address'; methodId: string };
  /**
   * Navigation stack: the callback data of every screen the user has opened, in
   * order. "⬅️ Back" pops it and re-renders the previous screen (src/bot/nav.ts).
   */
  navStack?: string[];
  /**
   * Callback data of the screen the user is *actually* looking at. Most screens
   * push themselves onto navStack, but transient ones (confirmations, previews,
   * "removed" receipts) must not be re-dispatched by Back - they are recorded
   * here instead, so Back knows to go to their parent rather than skipping it.
   */
  lastRendered?: string;
  /**
   * Country the user is currently choosing a number from. Kept here - not in
   * the callback data - because country+service+plan ids together exceed
   * Telegram's 64-byte limit for a button payload.
   */
  offerCountryId?: string;
  /** Admin add-numbers / CSV-import wizard: what has been chosen so far. */
  numberWizard?: { kind: 'ADD' | 'CSV'; countryId?: string; serviceId?: string };
  /** Number an admin is (re)assigning; the candidate buttons carry only a user id. */
  assignTarget?: { numberId: string; mode: 'ASSIGN' | 'REASSIGN' };
  /** Anti-abuse: last time we showed an error, to avoid spamming the user. */
  lastErrorAt?: number;
  captchaPassed?: boolean;
}

export const initialSession = (): SessionData => ({});

/** grammY storage adapter backed by the bot_sessions table. */
export function createPgSessionStorage<T>(): StorageAdapter<T> {
  return {
    async read(key: string): Promise<T | undefined> {
      const res = await query<{ value: T }>('SELECT value FROM bot_sessions WHERE key = $1', [key]);
      const value = res.rows[0]?.value;
      return value === undefined ? undefined : value;
    },
    async write(key: string, value: T): Promise<void> {
      await query(
        `INSERT INTO bot_sessions (key, value, updated_at) VALUES ($1, $2::jsonb, now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [key, JSON.stringify(value)],
      );
    },
    async delete(key: string): Promise<void> {
      await query('DELETE FROM bot_sessions WHERE key = $1', [key]);
    },
  };
}

/** Housekeeping: sessions are not useful forever. */
export async function purgeOldSessions(days = 30): Promise<number> {
  const res = await query('DELETE FROM bot_sessions WHERE updated_at < now() - ($1 || \' days\')::interval', [String(days)]);
  const count = res.rowCount ?? 0;
  if (count > 0) logger.debug({ count }, 'purged stale bot sessions');
  return count;
}

export function sessionKey(chatId: number | string, userId: number | string): string {
  return `${chatId}:${userId}`;
}
