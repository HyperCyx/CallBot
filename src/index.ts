import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { closePool, healthcheck } from './db/pool.js';
import { runMigrations } from './db/migrate.js';
import { createApiServer } from './api/server.js';
import { createBot, startBot } from './bot/index.js';
import { InlineKeyboard } from 'grammy';
import { createWorkerRunner } from './workers/index.js';
import { createTelegramSender } from './workers/telegramSender.js';
import { setApprovalDeliverySender } from './services/approvalDelivery.service.js';
import { getFreePBX, getLiveCallSource, isMockMode } from './freepbx/index.js';
import { runCompatibilityProbe } from './freepbx/compat.js';
import { FreePBXGraphQLClient } from './freepbx/client.js';
import type { NotificationSender } from './workers/render.js';

/**
 * Application entrypoint.
 *
 * One process runs three roles, which is the right trade-off for a deployment
 * of this size (and each can be split out later - the DB-backed queues make the
 * workers safe to run anywhere):
 *
 *   1. HTTP API         (internal backend + Telegram webhook + /health)
 *   2. Telegram bot     (handlers)
 *   3. Background workers (PBX jobs, notifications, CDR, reconciliation)
 */

async function main(): Promise<void> {
  logger.info({ env: env.NODE_ENV, freepbxMode: env.freepbx.mode }, 'starting sipbot');

  // 1. Database reachable?
  const db = await healthcheck();
  if (!db.ok) {
    logger.error({ error: db.error }, 'database is not reachable - refusing to start');
    process.exit(1);
  }
  logger.info({ latencyMs: db.latencyMs }, 'database connection ok');

  // 2. Migrations (idempotent; safe to run on every boot in this deployment model).
  try {
    const result = await runMigrations();
    if (result.applied.length > 0) logger.info({ applied: result.applied }, 'migrations applied');
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'migration failed - refusing to start with an unknown schema');
    process.exit(1);
  }

  // 3. PBX reachability + compatibility probe (never fatal: the platform must
  //    degrade gracefully and report the problem instead of dying).
  if (!isMockMode()) {
    try {
      await getFreePBX().authenticate();
      const report = await runCompatibilityProbe(new FreePBXGraphQLClient());
      if (!report.schemaOk) {
        logger.error({ missing: report.missing }, 'FreePBX API is missing required operations - some features will be disabled');
      }
    } catch (err) {
      logger.error({ err: (err as Error).message }, 'FreePBX is not reachable at startup; number assignment will fail until it is');
    }
  } else {
    logger.warn('FreePBX MOCK mode: no real PBX traffic will be generated');
  }

  // 4. Live call source (AMI).
  const liveSource = getLiveCallSource();
  await liveSource.start().catch((err) => logger.error({ err: (err as Error).message }, 'AMI start failed'));

  // 5. Bot.
  const bot = createBot();
  const sender: NotificationSender = createTelegramSender(
    bot ? bot.api.sendMessage.bind(bot.api) : (async () => { throw new Error('Telegram bot is not configured'); }),
  );
  // Approval DMs (SIP credentials) go out on the same authenticated channel.
  setApprovalDeliverySender(bot ? sender : null);

  if (bot) {
    // Session-driven workers deliver notifications through the bot API.
    await startBot(bot);
  } else {
    logger.warn('Telegram bot disabled (no TELEGRAM_BOT_TOKEN)');
  }

  // 6. Workers.
  const withReconciliation = process.env.WORKERS_IN_PROCESS !== 'false';
  const workers = withReconciliation ? createWorkerRunner({ sender }) : null;

  // 7. HTTP server.
  const app = createApiServer();
  const server = app.listen(env.API_PORT, env.API_HOST, () => {
    logger.info({ host: env.API_HOST, port: env.API_PORT }, 'HTTP API listening');
  });

  // ---------------------------------------------------------------------------
  // Graceful shutdown: stop taking work, finish in-flight requests, close pools.
  // ---------------------------------------------------------------------------
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');

    workers?.stop();
    await liveSource.stop().catch(() => undefined);
    if (bot) await bot.stop().catch(() => undefined);

    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closePool().catch(() => undefined);

    logger.info('shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    logger.error({ reason: reason instanceof Error ? reason.stack : String(reason) }, 'unhandled promise rejection');
  });
  process.on('uncaughtException', (err) => {
    // Include the syscall-level fields (code/syscall/address/port/hostname):
    // single-frame TLSWrap stacks carry no userland frames, so these fields
    // are the only way to identify the offending socket if this ever fires.
    const meta = err as NodeJS.ErrnoException & { address?: string; port?: number; hostname?: string };
    logger.fatal(
      {
        err: err.stack ?? err.message,
        code: meta.code ?? null,
        syscall: meta.syscall ?? null,
        address: meta.address ?? meta.hostname ?? null,
        port: meta.port ?? null,
      },
      'uncaught exception - exiting',
    );
    void shutdown('uncaughtException');
  });
}

main().catch((err) => {
  logger.fatal({ err: (err as Error)?.stack ?? String(err) }, 'fatal startup error');
  process.exit(1);
});
