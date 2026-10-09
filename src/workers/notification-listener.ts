import pg from 'pg';
import { env } from '../config/env.js';
import { sslFromConnectionString } from '../db/pool.js';
import { logger } from '../lib/logger.js';

/**
 * Notification fast path (LISTEN/NOTIFY).
 *
 * The outbox table remains the source of truth and the periodic poll remains
 * the backstop; this listener exists because a poll interval means every admin
 * alert (new applicant waiting!) arrives up to a full interval late. With
 * pg_notify emitted by the enqueue path, the worker sweeps the outbox within
 * ~250ms of the INSERT instead.
 *
 * Robustness contract:
 *  - the LISTEN client is dedicated (never pooled) and auto-reconnects with
 *    capped backoff, because the same cloud-LB idle-drop that killed pooled
 *    sockets will eventually kill this one too;
 *  - after every reconnect one wake is fired so events missed while offline
 *    are recovered immediately (the poll would also catch them, one interval
 *    later);
 *  - a failing listener NEVER takes the process down - worst case we degrade
 *    to poll-only behaviour.
 */

export const NOTIFICATIONS_CHANNEL = 'notifications_due';

/**
 * Debounced, single-flight trigger. A burst of wake signals collapses into one
 * run; a signal arriving mid-run schedules exactly one trailing run, so no
 * enqueue is ever lost and the sweeps are never overlapping (delivery is
 * non-idempotent - a duplicate DM looks broken to the operator).
 */
export function createWakeScheduler(run: () => Promise<void>, debounceMs = 250): { poke: () => void; stop: () => void } {
  let timer: NodeJS.Timeout | null = null;
  let running = false;
  let dirty = false;
  let stopped = false;

  const execute = async (): Promise<void> => {
    if (stopped || running) return;
    running = true;
    try {
      await run();
    } catch (err) {
      logger.error({ err: (err as Error).message }, 'wake-driven notifications sweep failed');
    } finally {
      running = false;
      if (dirty) {
        dirty = false;
        queue();
      }
    }
  };

  const queue = (): void => {
    if (stopped) return;
    if (running) {
      dirty = true;
      return;
    }
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      void execute();
    }, debounceMs);
  };

  return {
    poke: queue,
    stop: () => {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}

export interface NotificationListener {
  stop: () => Promise<void>;
}

/**
 * LISTENs on NOTIFICATIONS_CHANNEL and calls onWake for every notification.
 * Reconnects forever with capped backoff (500ms -> 15s); returns a handle whose
 * stop() shuts everything down quietly (called from process shutdown).
 */
export function startNotificationListener(onWake: () => void): NotificationListener {
  let stopped = false;
  let client: pg.Client | null = null;
  let retryMs = 500;
  let retryTimer: NodeJS.Timeout | null = null;

  const teardown = (): void => {
    const current = client;
    client = null;
    if (current) {
      current.removeAllListeners();
      // Never end() without an error listener: an RST arriving while end() is
      // flushing would be emitted with ZERO listeners on the client emitter
      // and Node treats that as an uncaught exception (this exact window was
      // observed live: FATAL "read ECONNRESET" ~6 minutes after the socket
      // went idle - the cloud load balancer's idle-reset cycle). A silent
      // sink keeps the "listener never takes the process down" contract true.
      current.on('error', () => undefined);
      void current.end().catch(() => undefined);
    }
  };

  const scheduleRetry = (why: string): void => {
    if (stopped || retryTimer) return;
    logger.warn({ why, retryMs }, 'notification listener disconnected; reconnecting (poll backstop continues)');
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void connect();
    }, retryMs);
    retryMs = Math.min(retryMs * 2, 15_000);
  };

  const connect = async (): Promise<void> => {
    if (stopped) return;
    const { connectionString, ssl } = sslFromConnectionString(env.DATABASE_URL);
    const c = new pg.Client({
      connectionString,
      ...(ssl ? { ssl } : {}),
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000,
      connectionTimeoutMillis: 10_000,
      application_name: 'sipbot-notify-listener',
    });
    client = c;
    c.on('notification', () => onWake());
    c.on('error', (err) => {
      teardown();
      scheduleRetry(err.message);
    });
    c.on('end', () => {
      teardown();
      scheduleRetry('connection ended');
    });
    try {
      await c.connect();
      await c.query(`LISTEN ${NOTIFICATIONS_CHANNEL}`);
      retryMs = 500;
      logger.info({ channel: NOTIFICATIONS_CHANNEL }, 'notification fast-path listener connected');
      // Events fired while we were disconnected are beyond recovery - sweep once.
      onWake();
    } catch (err) {
      teardown();
      scheduleRetry((err as Error).message);
    }
  };

  void connect();

  return {
    stop: async () => {
      stopped = true;
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      teardown();
    },
  };
}
