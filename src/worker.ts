import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { closePool, healthcheck } from './db/pool.js';
import { createWorkerRunner } from './workers/index.js';
import { getLiveCallSource } from './freepbx/index.js';
import { getFreePBX } from './freepbx/index.js';
import { applyLiveEvent, refreshLiveSessions } from './services/call.service.js';
import { runReconciliation } from './workers/reconcile.worker.js';
import { ingestCdrs } from './services/call.service.js';

/**
 * Standalone worker process (`npm run start:worker`).
 *
 * Runs the same workers as the main process, but without the bot handlers or
 * the HTTP API. This is the process to scale horizontally when the platform
 * grows: notification delivery, CDR ingestion and reconciliation all coordinate
 * through database locks, so N copies are safe.
 */

async function main(): Promise<void> {
  logger.info({ env: env.NODE_ENV }, 'starting sipbot worker');

  const db = await healthcheck();
  if (!db.ok) {
    logger.error({ error: db.error }, 'database is not reachable');
    process.exit(1);
  }

  // Live calls: subscribe to AMI events and keep call_sessions fresh.
  const liveSource = getLiveCallSource();
  if (liveSource.kind === 'ami') {
    liveSource.subscribe((event) => {
      void applyLiveEvent(event);
    });
  }
  await liveSource.start().catch((err) => logger.error({ err: (err as Error).message }, 'AMI start failed'));

  // The worker sends Telegram notifications only if it has a token; otherwise
  // the main process delivers them. Buttons MUST ride along (approval
  // requests carry ✅/❌) - createTelegramSender keeps this and the bot
  // process's sender identical forever.
  const { createTelegramSender } = await import('./workers/telegramSender.js');
  let sender: import('./workers/render.js').NotificationSender = async () => {
    throw new Error('this worker has no Telegram sender; run the main process to deliver notifications');
  };

  if (env.TELEGRAM_BOT_TOKEN) {
    const { Bot } = await import('grammy');
    const bot = new Bot(env.TELEGRAM_BOT_TOKEN);
    sender = createTelegramSender(bot.api.sendMessage.bind(bot.api));
  }

  const workers = createWorkerRunner({ sender, withReconciliation: true, withMembershipSweep: true });

  // Startup catch-up run so a restart does not delay reconciliation by a full interval.
  void runReconciliation({}).catch((err) => logger.warn({ err: (err as Error).message }, 'startup reconciliation failed'));
  void ingestCdrs({ maxPages: 3 }).catch(() => undefined);
  void refreshLiveSessions().catch(() => undefined);

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'worker shutting down');
    workers.stop();
    await liveSource.stop().catch(() => undefined);
    await closePool().catch(() => undefined);
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // Keep a reference so the process does not exit early.
  logger.info({ graphql: env.freepbx.graphqlUrl ? 'configured' : 'none', mode: getFreePBX().kind }, 'worker ready');
}

main().catch((err) => {
  logger.fatal({ err: (err as Error)?.stack ?? String(err) }, 'fatal worker error');
  process.exit(1);
});
