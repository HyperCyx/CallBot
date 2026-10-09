import type { Context, SessionFlavor } from 'grammy';
import type { SessionData } from './session.js';
import type { AdminRole, UserRow } from '../services/user.service.js';

/**
 * Request-scoped state attached by middleware, so handlers never have to
 * re-query the database for the caller's identity.
 *
 * `requestId` is propagated into audit rows and logs (spec §38 "request IDs").
 */
export interface RequestState {
  requestId: string;
  /** Application user row, when the Telegram account is linked to one. */
  user?: UserRow;
  role: AdminRole;
  isAdmin: boolean;
  isSuperAdmin: boolean;
  /** Why the update was rejected, if it was. */
  rejected?: string;
}

export type BotContext = Context & SessionFlavor<SessionData> & { state: RequestState };

export function newRequestId(prefix = 'tg'): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
