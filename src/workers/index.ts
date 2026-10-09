import { query } from '../db/pool.js';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { runReconciliation } from './reconcile.worker.js';
import { processJobs } from './job.worker.js';
import { claimDueNotifications, markNotificationFailed, markNotificationSent, type NotificationRow } from '../services/notification.service.js';
import { ingestCdrs, refreshLiveSessions } from '../services/call.service.js';
import { renderNotification, type NotificationButton, type NotificationSender } from './render.js';
import { getBool } from '../services/settings.service.js';
import { createWakeScheduler, startNotificationListener, type NotificationListener } from './notification-listener.js';

/**
 * Worker scheduler (spec §31, §32, §38).
 *
 * Runs inside the main process by default (single deployment unit, simplest to
 * operate) and can also run as a standalone container (`npm run start:worker`)
 * for horizontal scaling - the DB-backed queues make both safe.
 */

async function heartbeat(worker: string, status: 'IDLE' | 'RUNNING' | 'ERROR', error?: string): Promise<void> {
  await query(
    `INSERT INTO worker_heartbeats (worker, instance, status, last_run_at, run_count, last_error)
     VALUES ($1,$2,$3,now(),1,$4)
     ON CONFLICT (worker) DO UPDATE SET
        instance = EXCLUDED.instance,
        status = EXCLUDED.status,
        last_run_at = now(),
        run_count = worker_heartbeats.run_count + 1,
        last_success_at = CASE WHEN $3 = 'IDLE' THEN now() ELSE worker_heartbeats.last_success_at END,
        last_error = EXCLUDED.last_error`,
    [worker, `${process.pid}`, status, error ?? null],
  );
}

export interface WorkerRunner {
  stop: () => void;
  /** Runs one pass of everything; used by tests and by the admin "run now" button. */
  runOnce: () => Promise<void>;
}

export function createWorkerRunner(deps: { sender: NotificationSender; withReconciliation?: boolean; withListener?: boolean; withMembershipSweep?: boolean }): WorkerRunner {
  const timers: NodeJS.Timeout[] = [];
  let stopped = false;
  let listener: NotificationListener | null = null;

  const runNotifications = async (): Promise<void> => {
    const due = await claimDueNotifications(25);
    for (const notification of due) {
      try {
        await deliver(notification, deps.sender);
        await markNotificationSent(notification.id);
      } catch (err) {
        await markNotificationFailed(notification.id, (err as Error).message);
      }
    }
  };

  // Fast path: enqueues fire pg_notify, the listener pokes this scheduler and
  // the outbox is swept within ~250ms instead of waiting for the next poll.
  // Debounce + single-flight guard live in createWakeScheduler. Failure of the
  // listener only ever degrades us back to poll-only delivery.
  const wakeScheduler = createWakeScheduler(runNotifications);
  if (deps.withListener !== false) {
    listener = startNotificationListener(wakeScheduler.poke);
  }

  const runJobs = async (): Promise<void> => {
    await processJobs(20);
  };

  const runCdr = async (): Promise<void> => {
    try {
      await ingestCdrs({});
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'CDR ingestion failed (will retry next cycle)');
    }
  };

  const runLive = async (): Promise<void> => {
    if (!env.ami.enabled) return;
    try {
      await refreshLiveSessions();
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'live call refresh failed');
    }
  };

  const runReconcile = async (): Promise<void> => {
    try {
      await runReconciliation({});
    } catch (err) {
      await heartbeat('reconcile', 'ERROR', (err as Error).message);
      return;
    }
    await heartbeat('reconcile', 'IDLE');
  };

  const runOnce = async (): Promise<void> => {
    await runJobs();
    await runNotifications();
  };

  const schedule = (name: string, intervalMs: number, fn: () => Promise<void>, runImmediately = false): void => {
    const tick = async () => {
      if (stopped) return;
      try {
        await fn();
      } catch (err) {
        logger.error({ worker: name, err: (err as Error).message }, 'worker iteration failed');
        await heartbeat(name, 'ERROR', (err as Error).message).catch(() => undefined);
      } finally {
        if (!stopped) timers.push(setTimeout(tick, intervalMs));
      }
    };
    if (runImmediately) void tick();
    else timers.push(setTimeout(tick, intervalMs));
  };

  // Fast loops: job execution + notification delivery.
  schedule('jobs', 15_000, runJobs, true);
  schedule('notifications', 20_000, runNotifications, true);

  // Call data loops.
  void getBool('calls.cdr_sync_enabled', true)
    .then((enabled) => {
      if (enabled) schedule('cdr', 120_000, runCdr, false);
    })
    .catch(() => undefined);
  schedule('live-calls', 30_000, runLive, false);

  // Membership audit: userbot sweep of every required chat (hourly). Only the
  // dedicated worker process runs it (deps from worker.ts); a missing/expired
  // MTProto session is a quiet skip, not an alarm - see membershipAudit.service.
  if (deps.withMembershipSweep) {
    schedule('membership-sweep', 60 * 60_000, async () => {
      try {
        const { runSweepWithUserbot } = await import('./membershipSweep.worker.js');
        const summary = await runSweepWithUserbot();
        if (!summary.skipped) await heartbeat('membership-sweep', 'RUNNING').catch(() => undefined);
      } catch (err) {
        // USERBOT_UNAVAILABLE must not page anyone (operator may simply not
        // have completed the one-time login); everything else bubbles to the
        // scheduler's error path.
        if ((err as { code?: string }).code === 'USERBOT_UNAVAILABLE') {
          logger.info({ err: (err as Error).message }, 'membership sweep skipped (userbot not ready)');
          return;
        }
        throw err;
      }
    }, true);
  }

  // Reconciliation.
  if (deps.withReconciliation !== false) {
    const interval = Number(env.RECONCILE_INTERVAL_MS) || 300_000;
    schedule('reconcile', interval, runReconcile, false);
  }

  return {
    stop: () => {
      stopped = true;
      for (const t of timers) clearTimeout(t);
      wakeScheduler.stop();
      if (listener) void listener.stop();
    },
    runOnce,
  };
}

async function deliver(notification: NotificationRow, sender: NotificationSender): Promise<void> {
  const message = renderNotification(notification);
  if (!message) {
    // Nothing to send (e.g. an alert type that is not rendered): drop it.
    logger.debug({ kind: notification.kind }, 'notification has no rendered message; skipping');
    return;
  }

  let chatId = notification.telegram_id;
  if (!chatId && notification.user_id) {
    const res = await query<{ telegram_id: number | null }>('SELECT telegram_id FROM users WHERE id = $1', [notification.user_id]);
    chatId = res.rows[0]?.telegram_id ?? null;
  }
  if (!chatId) throw new Error('notification has no telegram target');

  await sender(chatId, message, { buttons: notificationButtons(notification) });
}

/**
 * Action buttons attached to specific notification kinds. The approval request
 * carries Approve/Reject straight into the admin's DM (product decision) - the
 * callbacks route through the same handlers as the panel flow, so the DM
 * updates with the receipt either way.
 */
export function notificationButtons(notification: NotificationRow): NotificationButton[][] | undefined {
  if (notification.kind === 'ADMIN_NEW_USER') {
    const userId = typeof notification.payload?.userId === 'string' ? notification.payload.userId : null;
    if (userId && /^[0-9a-f-]{36}$/i.test(userId)) {
      return [[
        { text: '✅ Approve', callbackData: `a:uap:${userId}` },
        { text: '❌ Reject', callbackData: `a:urej:${userId}` },
      ]];
    }
  }
  if (notification.kind === 'ADMIN_DEPOSIT_REQUEST') {
    const requestId = typeof notification.payload?.requestId === 'string' ? notification.payload.requestId : null;
    if (requestId && /^[0-9a-f-]{36}$/i.test(requestId)) {
      return [[
        { text: '✅ Approve & credit', callbackData: `a:dpok:${requestId}` },
        { text: '❌ Reject', callbackData: `a:dpno:${requestId}` },
      ]];
    }
  }
  return undefined;
}

