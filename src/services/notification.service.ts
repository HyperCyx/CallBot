import { many, one, query } from '../db/pool.js';
import { logger } from '../lib/logger.js';
import { metrics } from '../lib/metrics.js';

/**
 * Notification outbox (spec §31, §32).
 *
 * Notifications are queued in the database rather than sent inline, so:
 *   * a Telegram outage never loses an expiry reminder (it retries),
 *   * a worker crash cannot double-send (dedupe_key is UNIQUE),
 *   * the admin can see what was (not) delivered.
 */

export type NotificationKind =
  | 'USER_APPROVED'
  | 'USER_REJECTED'
  | 'USER_BLOCKED'
  | 'USER_UNBLOCKED'
  | 'NUMBER_ASSIGNED'
  | 'NUMBER_RELEASED'
  | 'NUMBER_SUSPENDED'
  | 'NUMBER_UNSUSPENDED'
  | 'EXPIRY_WARNING'
  | 'EXPIRED'
  | 'USER_DEPOSIT_APPROVED'
  | 'USER_DEPOSIT_REJECTED'
  | 'WALLET_CREDITED'
  | 'ADMIN_NEW_USER'
  | 'ADMIN_DEPOSIT_REQUEST'
  | 'ADMIN_ALERT'
  | 'RECONCILIATION_ALERT'
  | 'SUPPORT_REPLY'
  | 'CUSTOM';

export interface EnqueueNotificationInput {
  userId?: string | null;
  telegramId?: number | null;
  kind: NotificationKind;
  payload?: Record<string, unknown>;
  /** Unique per logical event so retries cannot double-send. */
  dedupeKey?: string | null;
  nextRunAt?: Date;
}

export async function enqueueNotification(input: EnqueueNotificationInput): Promise<void> {
  await query(
    `INSERT INTO notifications (user_id, telegram_id, kind, payload, dedupe_key, next_run_at)
     VALUES ($1,$2,$3,$4::jsonb,$5,$6)
     ON CONFLICT (dedupe_key) DO NOTHING`,
    [
      input.userId ?? null,
      input.telegramId ?? null,
      input.kind,
      JSON.stringify(input.payload ?? {}),
      input.dedupeKey ?? null,
      input.nextRunAt ?? new Date(),
    ],
  );
  // Wake the worker's LISTENer so due rows are delivered within ~250ms instead
  // of waiting for the next poll. Fire-and-forget: if the database is blipping
  // or no listener is up, the periodic poll still delivers (just one interval
  // later) - the outbox remains the source of truth, NOTIFY is only the bell.
  void query(`SELECT pg_notify('notifications_due', '')`).catch(() => undefined);
}

/** Convenience: notify every admin (used for new-user and drift alerts). */
export async function enqueueAdminNotification(
  kind: NotificationKind,
  payload: Record<string, unknown>,
  dedupeKey?: string,
): Promise<void> {
  const admins = await many<{ telegram_id: number }>(
    `SELECT DISTINCT u.telegram_id
       FROM users u
       JOIN user_roles ur ON ur.user_id = u.id
       JOIN roles r ON r.id = ur.role_id
      WHERE u.telegram_id IS NOT NULL AND u.status = 'ACTIVE' AND r.code IN ('admin','super_admin')`,
  );
  const targets = new Set<number>(admins.map((a) => a.telegram_id));
  // The environment allowlist is included so a fresh deployment with no roles
  // granted yet still alerts its owner.
  const { env } = await import('../config/env.js');
  for (const id of env.superAdminIds) targets.add(Number(id));

  for (const telegramId of targets) {
    await enqueueNotification({
      telegramId,
      kind,
      payload,
      dedupeKey: dedupeKey ? `${dedupeKey}:${telegramId}` : null,
    });
  }
}

export interface NotificationRow {
  id: string;
  user_id: string | null;
  telegram_id: number | null;
  kind: NotificationKind;
  payload: Record<string, unknown>;
  dedupe_key: string | null;
  status: 'PENDING' | 'SENT' | 'FAILED' | 'CANCELLED';
  attempts: number;
  max_attempts: number;
  next_run_at: Date;
  last_error: string | null;
}

/** Atomically claims due notifications (multiple workers are safe). */
export async function claimDueNotifications(limit = 20): Promise<NotificationRow[]> {
  return many<NotificationRow>(
    `WITH due AS (
       SELECT id FROM notifications
        WHERE status IN ('PENDING','FAILED') AND next_run_at <= now() AND attempts < max_attempts
        ORDER BY next_run_at ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED
     )
     UPDATE notifications n SET attempts = n.attempts + 1
       FROM due WHERE n.id = due.id
     RETURNING n.*`,
    [limit],
  );
}

export async function markNotificationSent(id: string): Promise<void> {
  await query("UPDATE notifications SET status = 'SENT', sent_at = now(), last_error = NULL WHERE id = $1", [id]);
  metrics.counters.notifySent.inc(1);
}

/**
 * Telegram errors that will never succeed on a retry: the chat does not exist
 * (the user never pressed /start, or the account was removed) or the bot is
 * blocked. Retrying those only burns API calls, so they fail immediately.
 */
const PERMANENT_TELEGRAM_ERRORS = [
  'chat not found',
  'bot was blocked by the user',
  'user is deactivated',
  'bot can\'t initiate conversation with a user',
  'chat_id is empty',
];

export function isPermanentDeliveryError(error: string): boolean {
  const text = error.toLowerCase();
  return PERMANENT_TELEGRAM_ERRORS.some((needle) => text.includes(needle));
}

export async function markNotificationFailed(id: string, error: string): Promise<void> {
  const permanent = isPermanentDeliveryError(error);

  await query(
    `UPDATE notifications
        SET status = CASE WHEN $3::boolean OR attempts >= max_attempts THEN 'FAILED' ELSE 'PENDING' END,
            last_error = $2,
            -- 10s, 20s, 40s, ... : a transient hiccup must retry in seconds,
            -- not hide a user-facing DM for whole minutes (the old 2^n-minute
            -- backoff made the first Telegram/DB blip look like a lost message).
            next_run_at = CASE WHEN $3::boolean THEN next_run_at
                               ELSE now() + (interval '10 seconds' * power(2, LEAST(GREATEST(attempts, 1) - 1, 6))) END
      WHERE id = $1`,
    [id, error.slice(0, 500), permanent],
  );
  metrics.counters.notifyFailed.inc(1);
  logger.warn({ id, error: error.slice(0, 200), permanent }, 'notification delivery failed');
}

export async function cancelNotificationsForUser(userId: string): Promise<void> {
  await query("UPDATE notifications SET status = 'CANCELLED' WHERE user_id = $1 AND status IN ('PENDING','FAILED')", [userId]);
}

export async function notificationStats(): Promise<Record<string, number>> {
  const row = await one<Record<string, string>>(
    `SELECT
       count(*) FILTER (WHERE status = 'PENDING')::text AS pending,
       count(*) FILTER (WHERE status = 'SENT')::text AS sent,
       count(*) FILTER (WHERE status = 'FAILED')::text AS failed
     FROM notifications`,
  );
  return {
    pending: Number(row?.pending ?? 0),
    sent: Number(row?.sent ?? 0),
    failed: Number(row?.failed ?? 0),
  };
}
