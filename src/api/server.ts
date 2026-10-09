import express, { type NextFunction, type Request, type Response } from 'express';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { metrics } from '../lib/metrics.js';
import { AppError, toAppError } from '../lib/errors.js';
import { safeEqual } from '../lib/crypto.js';
import { healthcheck, query } from '../db/pool.js';
import { createBot } from '../bot/index.js';
import { deleteUserAccount } from '../services/userDeletion.service.js';
import { approveUser, blockUser, getUserById, listUsers, softDeleteUser, unblockUser, findUserForTelegram } from '../services/user.service.js';
import { deliverApprovalCredentials } from '../services/approvalDelivery.service.js';
import { enqueueNotification } from '../services/notification.service.js';
import { deleteSipAccount } from '../services/extension.service.js';
import { assignNumber, reassignNumber, releaseNumber, suspendNumber, unsuspendNumber } from '../services/assignment.service.js';
import { deleteNumber, importNumbers, inventoryRemovalPreview, listNumbers, getNumberById, removeAllAvailableNumbers } from '../services/inventory.service.js';
import { createService, updateService, listServices, listCountries, createCountry, deleteCountry, deleteService, listPlans, createPlan, updatePlan } from '../services/catalog.service.js';
import { getLiveCalls, getSystemCallHistory, getUserCallHistory, ingestCdrs } from '../services/call.service.js';
import { evaluateReferralQualification, getReferralStats, rejectReferral } from '../services/referral.service.js';
import { getDashboard } from '../services/stats.service.js';
import { runReconciliation, getOpenFindings, resolveFinding } from '../workers/reconcile.worker.js';
import { listAuditLogs } from '../services/audit.service.js';
import { getAllSettings, setSetting } from '../services/settings.service.js';
import { getStoredCompatibilityReport, runCompatibilityProbe } from '../freepbx/compat.js';
import { FreePBXGraphQLClient } from '../freepbx/client.js';
import { getFreePBX, isMockMode } from '../freepbx/index.js';
import { revealCredentials, provisionSipAccount, getSipAccountByUser } from '../services/extension.service.js';
import { listRecentJobs } from '../services/pbxJob.service.js';
import { purgeOldSessions } from '../bot/session.js';
import { z } from 'zod';

/**
 * Internal backend API (spec §29).
 *
 * This is what the bot's handlers and any external operator tooling call. It is
 * NOT the user-facing surface: Telegram never talks to FreePBX, and this API
 * exposes no FreePBX credentials.
 *
 * Security model
 * --------------
 *  * `x-api-key` shared secret, compared in constant time, required on /api/*.
 *  * Optional IP allowlist (CIDR) for the admin API.
 *  * Per-IP rate limiting.
 *  * Idempotency-Key support on every mutating route: a retry replays the first
 *    response instead of re-executing the side effect.
 *  * Every request gets a request id that lands in the logs and audit rows.
 *  * Errors never leak internals: AppError messages are user-safe by design.
 */

const uuid = z.string().uuid();

interface IdempotencyRecord {
  status: 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';
  response_code?: number;
  response_body?: unknown;
}

export function createApiServer(): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);
  app.use(express.json({ limit: '5mb' }));

  // ---------------------------------------------------------------------------
  // request id + access log + latency metric
  // ---------------------------------------------------------------------------
  app.use((req, res, next) => {
    const requestId = (req.header('x-request-id') ?? `api-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`).slice(0, 80);
    res.locals.requestId = requestId;
    res.setHeader('x-request-id', requestId);
    const started = Date.now();
    res.on('finish', () => {
      const ms = Date.now() - started;
      metrics.counters.apiRequests.inc(1, { method: req.method, route: req.route?.path ?? req.path, status: res.statusCode });
      metrics.histograms.apiLatencyMs.observe(ms, { method: req.method });
      logger.info({ requestId, method: req.method, path: req.path, status: res.statusCode, ms }, 'api request');
    });
    next();
  });

  // ---------------------------------------------------------------------------
  // health & metrics (unauthenticated, no sensitive data)
  // ---------------------------------------------------------------------------
  app.get('/health', async (_req, res) => {
    const db = await healthcheck();
    const pbx = isMockMode() ? { ok: true, detail: 'mock' } : await getFreePBX().ping().catch((err) => ({ ok: false, detail: (err as Error).message }));
    const ok = db.ok;
    res.status(ok ? 200 : 503).json({
      status: ok ? 'ok' : 'degraded',
      database: db,
      freepbx: { mode: env.freepbx.mode, ...pbx },
      ami: await (await import('../services/call.service.js')).liveCallSourceStatus(),
      version: '1.0.0',
    });
  });

  // Prometheus scrapes text; humans and dashboards want the JSON snapshot, so
  // both are served (spec §38).
  app.get('/metrics', (_req, res) => {
    res.type('text/plain; version=0.0.4').send(metrics.toPrometheus());
  });

  app.get('/metrics.json', async (_req, res) => {
    const dashboard = await getDashboard().catch(() => null);
    res.json({ metrics: metrics.snapshot(), dashboard: dashboard ?? undefined });
  });

  // ---------------------------------------------------------------------------
  // authentication
  // ---------------------------------------------------------------------------
  const ipAllowed = (ip: string | undefined): boolean => {
    if (env.apiIpAllowlist.length === 0) return true;
    if (!ip) return false;
    const normalized = ip.replace(/^::ffff:/, '');
    return env.apiIpAllowlist.some((entry) => {
      if (entry.includes('/')) {
        const [base, bitsRaw] = entry.split('/');
        const bits = Number(bitsRaw);
        const toInt = (v: string) => v.split('.').reduce((acc, part) => acc * 256 + Number(part), 0);
        if (!base || !Number.isFinite(bits) || bits <= 0 || bits > 32) return false;
        const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
        return (toInt(normalized) & mask) === (toInt(base) & mask);
      }
      return entry === normalized;
    });
  };

  const requireAuth = (req: Request, res: Response, next: NextFunction): void => {
    if (!ipAllowed(req.ip)) {
      metrics.counters.apiErrors.inc(1, { reason: 'ip_blocked' });
      res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Source IP is not allowed' }, requestId: res.locals.requestId });
      return;
    }
    const key = req.header('x-api-key') ?? '';
    if (!key || !safeEqual(key, env.API_KEY)) {
      metrics.counters.apiErrors.inc(1, { reason: 'unauthorized' });
      logger.warn({ ip: req.ip, path: req.path }, 'api authentication failed');
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Invalid or missing API key' }, requestId: res.locals.requestId });
      return;
    }
    next();
  };

  app.use('/api', requireAuth);

  // ---------------------------------------------------------------------------
  // idempotency for mutating calls
  // ---------------------------------------------------------------------------
  const idempotency: express.RequestHandler = async (req, res, next) => {
    if (!['POST', 'PATCH', 'DELETE', 'PUT'].includes(req.method)) return next();
    const header = req.header('idempotency-key')?.trim().slice(0, 200);
    if (!header) return next();

    const scope = `${req.method} ${req.baseUrl}${req.path}`;
    const existing = await query<{ status: string; request_hash: string; response_code: number | null; response_body: unknown }>(
      'SELECT status, request_hash, response_code, response_body FROM idempotency_keys WHERE key = $1 AND scope = $2',
      [header, scope],
    );
    const row = existing.rows[0] as IdempotencyRecord | undefined;
    if (row && row.status === 'COMPLETED') {
      logger.info({ idempotencyKey: header, scope }, 'replaying idempotent response');
      res.status(row.response_code ?? 200).json(row.response_body);
      return;
    }
    if (row && row.status === 'IN_PROGRESS') {
      // A concurrent retry, not a replay: running the operation twice is exactly
      // what this key exists to prevent, so the caller is told to wait.
      logger.warn({ idempotencyKey: header, scope }, 'idempotency key is still in progress; refusing to run twice');
      res.status(409).json({
        error: { code: 'CONFLICT', message: 'A request with this Idempotency-Key is still in progress. Retry in a moment.' },
      });
      return;
    }

    await query(
      `INSERT INTO idempotency_keys (key, scope, request_hash, status, actor_id)
       VALUES ($1,$2,$3,'IN_PROGRESS',NULL)
       ON CONFLICT (key) DO NOTHING`,
      [header, scope, JSON.stringify(req.body ?? {})],
    );

    // The completion record must be written BEFORE the response goes out.
    // Written after (fire and forget), a client retrying immediately - the
    // whole point of an Idempotency-Key - would not see it yet and the
    // operation would run a second time.
    const originalJson = res.json.bind(res);
    res.json = ((body: unknown) => {
      const statusCode = res.statusCode;
      query(
        `UPDATE idempotency_keys SET status = $3, response_code = $4, response_body = $5::jsonb
          WHERE key = $1 AND scope = $2`,
        [header, scope, statusCode < 400 ? 'COMPLETED' : 'FAILED', statusCode, JSON.stringify(body ?? {})],
      )
        .catch(() => undefined)
        .finally(() => originalJson(body));
      return res;
    }) as typeof res.json;

    next();
  };

  const asyncRoute =
    (fn: (req: Request, res: Response) => Promise<void>): express.RequestHandler =>
    (req, res, next) => {
      fn(req, res).catch(next);
    };

  const requestId = (res: Response): string => String(res.locals.requestId);

  /**
   * `?force=1` or a JSON body `{"force": true}`: the caller accepts that the
   * numbers a catalogue entry still has in users' hands are revoked with it
   * (inbound route removed, number retired, holder notified).
   */
  const wantsForce = (req: Request): boolean => {
    const query = req.query?.force;
    if (query === '1' || query === 'true') return true;
    return (req.body as { force?: boolean } | undefined)?.force === true;
  };

  /** Resolves the acting admin from the optional x-actor-user-id header. */
  const actorId = async (req: Request): Promise<string | null> => {
    const id = req.header('x-actor-user-id');
    if (id && uuid.safeParse(id).success) return id;
    const telegramId = req.header('x-actor-telegram-id');
    if (telegramId) {
      const user = await findUserForTelegram(Number(telegramId));
      return user?.id ?? null;
    }
    return null;
  };

  // ---------------------------------------------------------------------------
  // users
  // ---------------------------------------------------------------------------
  app.get(
    '/api/admin/users',
    asyncRoute(async (req, res) => {
      const status = (req.query.status as string | undefined) ?? 'ALL';
      const { rows, total } = await listUsers({
        status: status as never,
        search: (req.query.search as string | undefined) ?? undefined,
        limit: Number(req.query.limit ?? 20),
        offset: Number(req.query.offset ?? 0),
      });
      res.json({ data: rows, total });
    }),
  );

  app.post(
    '/api/admin/users/:id/approve',
    idempotency,
    asyncRoute(async (req, res) => {
      const id = uuid.parse(req.params.id);
      const actor = (await actorId(req)) ?? id;
      const user = await approveUser(id, { actorId: actor, requestId: requestId(res) });
      // Provisioning is a separate step so a PBX outage does not undo the approval.
      let provisioned: unknown = null;
      let warning: string | null = null;
      try {
        provisioned = await provisionSipAccount(id, { actorId: actor, requestId: requestId(res) });
        // Same owner-facing DM as the panel approval (see approvalDelivery).
        const creds = (provisioned as { credentials?: { extension?: string; password?: string } } | null)?.credentials;
        if (creds?.extension && creds.password) {
          const delivered = await deliverApprovalCredentials({
            telegramId: Number(user.telegram_id),
            extension: creds.extension,
            password: creds.password,
            expiresAt: user.expires_at,
          });
          if (!delivered) {
            await enqueueNotification({
              userId: id,
              kind: 'USER_APPROVED',
              payload: { extension: creds.extension },
              dedupeKey: `approved:${id}`,
            });
          }
        }
      } catch (err) {
        warning = toAppError(err).userMessage;
      }
      res.status(200).json({ data: { user, sip: provisioned, warning } });
    }),
  );

  app.post(
    '/api/admin/users/:id/block',
    idempotency,
    asyncRoute(async (req, res) => {
      const id = uuid.parse(req.params.id);
      await blockUser(id, { actorId: (await actorId(req)) ?? id, reason: String(req.body?.reason ?? 'blocked via API'), requestId: requestId(res) });
      res.json({ data: await getUserById(id) });
    }),
  );

  app.post(
    '/api/admin/users/:id/unblock',
    idempotency,
    asyncRoute(async (req, res) => {
      const id = uuid.parse(req.params.id);
      await unblockUser(id, { actorId: (await actorId(req)) ?? id, requestId: requestId(res) });
      res.json({ data: await getUserById(id) });
    }),
  );

  // A catalogue entry whose numbers are in users' hands is refused (409) unless
  // the caller opts in with ?force=1 / {"force":true} - then those numbers are
  // revoked from their holders (routes removed, holders notified) as part of the
  // removal. The panel asks for force only after showing the warning screen.
  app.delete(
    '/api/admin/services/:id',
    idempotency,
    asyncRoute(async (req, res) => {
      res.json({
        data: await deleteService(uuid.parse(req.params.id), {
          actorId: (await actorId(req)) ?? 'api',
          requestId: requestId(res),
          force: wantsForce(req),
        }),
      });
    }),
  );

  app.delete(
    '/api/admin/countries/:id',
    idempotency,
    asyncRoute(async (req, res) => {
      res.json({
        data: await deleteCountry(uuid.parse(req.params.id), {
          actorId: (await actorId(req)) ?? 'api',
          requestId: requestId(res),
          force: wantsForce(req),
        }),
      });
    }),
  );

  app.delete(
    '/api/admin/users/:id',
    idempotency,
    asyncRoute(async (req, res) => {
      const id = uuid.parse(req.params.id);
      // One service owns the contract: every number the account holds is
      // released and its route removed, the SIP account and PBX extension are
      // deleted, then the account itself (soft).
      const result = await deleteUserAccount(id, {
        actorId: (await actorId(req)) ?? id,
        reason: 'user deleted via API',
        requestId: requestId(res),
      });
      res.json({ data: { deleted: id, releasedNumbers: result.releasedNumbers, sipAccountDeleted: result.sipAccountDeleted } });
    }),
  );

  app.get(
    '/api/admin/users/:id/sip',
    asyncRoute(async (req, res) => {
      const id = uuid.parse(req.params.id);
      const account = await getSipAccountByUser(id);
      if (!account) throw new AppError('NOT_FOUND', 'This user has no SIP account');
      const credentials = await revealCredentials(account.id, {
        actorId: (await actorId(req)) ?? null,
        reason: 'credentials read via API',
      });
      res.json({ data: credentials });
    }),
  );

  // ---------------------------------------------------------------------------
  // numbers
  // ---------------------------------------------------------------------------
  app.post(
    '/api/admin/numbers/import',
    idempotency,
    asyncRoute(async (req, res) => {
      const body = z
        .object({
          countryId: uuid,
          serviceId: uuid,
          planType: z.enum(['FREE', 'PREMIUM']).default('FREE'),
          provider: z.string().optional(),
          priceCents: z.number().int().nonnegative().optional(),
          currency: z.string().length(3).optional(),
          expirationDate: z.string().optional(),
          csv: z.string().optional(),
          numbers: z.array(z.string()).optional(),
          // The acting admin may also come from the x-actor-user-id header; an
          // unattributed admin write is refused rather than silently recorded
          // as SYSTEM (spec §28).
          actorId: uuid.optional(),
        })
        .parse(req.body);
      const actor = body.actorId ?? (await actorId(req));
      if (!actor) {
        throw new AppError('BAD_INPUT', 'Provide x-actor-user-id (or actorId) so the import can be attributed.');
      }
      const result = await importNumbers({
        countryId: body.countryId,
        serviceId: body.serviceId,
        planType: body.planType,
        actorId: actor,
        ...(body.provider ? { provider: body.provider } : {}),
        ...(body.priceCents !== undefined ? { priceCents: body.priceCents } : {}),
        ...(body.currency ? { currency: body.currency } : {}),
        ...(body.expirationDate ? { expirationDate: body.expirationDate } : {}),
        ...(body.csv ? { csvText: body.csv } : {}),
        ...(body.numbers ? { numbers: body.numbers } : {}),
        source: 'API',
      });
      res.status(201).json({ data: result });
    }),
  );

  app.post(
    '/api/admin/numbers/assign',
    idempotency,
    asyncRoute(async (req, res) => {
      const body = z
        .object({
          userId: uuid,
          countryId: uuid.optional(),
          serviceId: uuid.optional(),
          planType: z.enum(['FREE', 'PREMIUM']).optional(),
          numberId: uuid.optional(),
          actorId: uuid.optional(),
          /** Take the new number and release the oldest one the user holds. */
          replaceOldest: z.boolean().optional(),
        })
        .parse(req.body);
      const result = await assignNumber({
        userId: body.userId,
        source: 'API',
        actorId: body.actorId ?? body.userId,
        requestId: requestId(res),
        ...(body.countryId ? { countryId: body.countryId } : {}),
        ...(body.serviceId ? { serviceId: body.serviceId } : {}),
        ...(body.planType ? { planType: body.planType } : {}),
        ...(body.numberId ? { numberId: body.numberId } : {}),
        ...(body.replaceOldest ? { replaceOldest: true } : {}),
      });
      res.status(201).json({ data: result });
    }),
  );

  app.post(
    '/api/admin/numbers/reassign',
    idempotency,
    asyncRoute(async (req, res) => {
      const body = z.object({ numberId: uuid, toUserId: uuid, actorId: uuid }).parse(req.body);
      const result = await reassignNumber(body.numberId, body.toUserId, {
        actorId: body.actorId,
        reason: 'reassignment via API',
        requestId: requestId(res),
      });
      res.json({ data: result });
    }),
  );

  app.post(
    '/api/admin/numbers/release',
    idempotency,
    asyncRoute(async (req, res) => {
      const body = z.object({ numberId: uuid, actorId: uuid, reason: z.string().optional() }).parse(req.body);
      await releaseNumber(body.numberId, {
        actorId: body.actorId,
        actorType: 'ADMIN',
        reason: body.reason ?? 'released via API',
        requestId: requestId(res),
      });
      res.json({ data: { released: body.numberId } });
    }),
  );

  app.post(
    '/api/admin/numbers/suspend',
    idempotency,
    asyncRoute(async (req, res) => {
      const body = z.object({ numberId: uuid, actorId: uuid, reason: z.string().optional() }).parse(req.body);
      await suspendNumber(body.numberId, { actorId: body.actorId, reason: body.reason ?? 'suspended via API', requestId: requestId(res) });
      res.json({ data: await getNumberById(body.numberId) });
    }),
  );

  app.post(
    '/api/admin/numbers/unsuspend',
    idempotency,
    asyncRoute(async (req, res) => {
      const body = z.object({ numberId: uuid, actorId: uuid }).parse(req.body);
      await unsuspendNumber(body.numberId, { actorId: body.actorId, requestId: requestId(res) });
      res.json({ data: await getNumberById(body.numberId) });
    }),
  );

  app.delete(
    '/api/admin/numbers/:id',
    idempotency,
    asyncRoute(async (req, res) => {
      const id = uuid.parse(req.params.id);
      const force = req.query.force === 'true';
      await deleteNumber(id, { actorId: (await actorId(req)) ?? id, force, requestId: requestId(res) });
      res.json({ data: { deleted: id } });
    }),
  );

  app.get(
    '/api/admin/numbers/removal-preview',
    asyncRoute(async (_req, res) => {
      res.json({ data: await inventoryRemovalPreview() });
    }),
  );

  /**
   * Removes every AVAILABLE number (optionally only one country's or one
   * service's). Assigned/suspended/reserved numbers are never touched - the
   * response says how many were kept so a caller can see that upfront.
   */
  app.delete(
    '/api/admin/numbers',
    idempotency,
    asyncRoute(async (req, res) => {
      const result = await removeAllAvailableNumbers({
        actorId: (await actorId(req)) ?? 'api',
        ...(req.query.countryId ? { countryId: String(req.query.countryId) } : {}),
        ...(req.query.serviceId ? { serviceId: String(req.query.serviceId) } : {}),
        requestId: requestId(res),
      });
      res.json({ data: result });
    }),
  );

  app.get(
    '/api/admin/numbers',
    asyncRoute(async (req, res) => {
      const { rows, total } = await listNumbers({
        status: (req.query.status as never) ?? undefined,
        countryId: (req.query.countryId as string | undefined) ?? undefined,
        serviceId: (req.query.serviceId as string | undefined) ?? undefined,
        assignedUserId: (req.query.userId as string | undefined) ?? undefined,
        limit: Number(req.query.limit ?? 20),
        offset: Number(req.query.offset ?? 0),
      });
      res.json({ data: rows, total });
    }),
  );

  // ---------------------------------------------------------------------------
  // catalog
  // ---------------------------------------------------------------------------
  app.get(
    '/api/admin/services',
    asyncRoute(async (_req, res) => {
      res.json({ data: await listServices() });
    }),
  );

  app.post(
    '/api/admin/services',
    idempotency,
    asyncRoute(async (req, res) => {
      const body = z.object({ name: z.string().min(1), description: z.string().optional(), icon: z.string().optional(), slug: z.string().optional() }).parse(req.body);
      res.status(201).json({ data: await createService({ name: body.name, ...(body.description ? { description: body.description } : {}), ...(body.icon ? { icon: body.icon } : {}), ...(body.slug ? { slug: body.slug } : {}) }) });
    }),
  );

  app.patch(
    '/api/admin/services/:id',
    idempotency,
    asyncRoute(async (req, res) => {
      const body = z
        .object({ name: z.string().optional(), description: z.string().optional(), icon: z.string().optional(), status: z.enum(['ACTIVE', 'DISABLED']).optional() })
        .parse(req.body);
      res.json({ data: await updateService(uuid.parse(req.params.id), body) });
    }),
  );

  app.get(
    '/api/admin/countries',
    asyncRoute(async (_req, res) => {
      res.json({ data: await listCountries() });
    }),
  );

  app.post(
    '/api/admin/countries',
    idempotency,
    asyncRoute(async (req, res) => {
      const body = z.object({ name: z.string().min(1), iso2: z.string().length(2), iso3: z.string().length(3).optional(), dialCode: z.string(), flag: z.string().optional() }).parse(req.body);
      res.status(201).json({
        data: await createCountry({
          name: body.name,
          iso2: body.iso2,
          dialCode: body.dialCode,
          ...(body.iso3 ? { iso3: body.iso3 } : {}),
          ...(body.flag ? { flag: body.flag } : {}),
        }),
      });
    }),
  );

  app.get(
    '/api/admin/plans',
    asyncRoute(async (_req, res) => {
      res.json({ data: await listPlans() });
    }),
  );

  app.post(
    '/api/admin/plans',
    idempotency,
    asyncRoute(async (req, res) => {
      const body = z
        .object({
          code: z.string().min(1),
          name: z.string().min(1),
          maxNumbers: z.number().int().nonnegative().default(1),
          allowsPremiumNumbers: z.boolean().default(false),
          priceCentsPerMonth: z.number().int().nonnegative().default(0),
          currency: z.string().length(3).default('EUR'),
          durationDays: z.number().int().positive().default(30),
          rank: z.number().int().default(0),
        })
        .parse(req.body);
      res.status(201).json({ data: await createPlan(body) });
    }),
  );

  app.patch(
    '/api/admin/plans/:id',
    idempotency,
    asyncRoute(async (req, res) => {
      const body = z
        .object({
          name: z.string().optional(),
          maxNumbers: z.number().int().nonnegative().optional(),
          allowsPremiumNumbers: z.boolean().optional(),
          priceCentsPerMonth: z.number().int().nonnegative().optional(),
          durationDays: z.number().int().positive().optional(),
          isActive: z.boolean().optional(),
        })
        .parse(req.body);
      res.json({ data: await updatePlan(uuid.parse(req.params.id), body) });
    }),
  );

  // ---------------------------------------------------------------------------
  // calls
  // ---------------------------------------------------------------------------
  app.get(
    '/api/admin/live-calls',
    asyncRoute(async (_req, res) => {
      const status = await (await import('../services/call.service.js')).liveCallSourceStatus();
      res.json({ data: await getLiveCalls(), source: status, note: 'Live data comes from Asterisk AMI. CDR is history only.' });
    }),
  );

  app.get(
    '/api/admin/calls',
    asyncRoute(async (req, res) => {
      const { rows, total } = await getSystemCallHistory({ limit: Number(req.query.limit ?? 50), offset: Number(req.query.offset ?? 0) });
      res.json({ data: rows, total });
    }),
  );

  app.post(
    '/api/admin/calls/sync',
    idempotency,
    asyncRoute(async (_req, res) => {
      const result = await ingestCdrs({ maxPages: Number(process.env.CDR_SYNC_PAGES ?? 10) });
      res.json({ data: result });
    }),
  );

  app.get(
    '/api/users/:id/calls',
    asyncRoute(async (req, res) => {
      const id = uuid.parse(req.params.id);
      const { rows, total } = await getUserCallHistory(id, { limit: Number(req.query.limit ?? 50), offset: Number(req.query.offset ?? 0) });
      res.json({ data: rows, total });
    }),
  );

  // ---------------------------------------------------------------------------
  // referrals
  // ---------------------------------------------------------------------------
  app.post(
    '/api/referrals/validate',
    asyncRoute(async (req, res) => {
      const body = z.object({ userId: uuid, event: z.enum(['SIGNUP', 'USER_APPROVED', 'FIRST_NUMBER_ASSIGNED', 'PLAN_PURCHASED']) }).parse(req.body);
      const result = await evaluateReferralQualification(body.userId, body.event);
      res.json({ data: result });
    }),
  );

  app.get(
    '/api/admin/referrals/:userId',
    asyncRoute(async (req, res) => {
      const id = uuid.parse(req.params.userId);
      res.json({ data: await getReferralStats(id, 'bot') });
    }),
  );

  app.post(
    '/api/admin/referrals/:id/reject',
    idempotency,
    asyncRoute(async (req, res) => {
      const id = uuid.parse(req.params.id);
      const reason = String(req.body?.reason ?? 'rejected via API');
      await rejectReferral(id, reason, (await actorId(req)) ?? 'system');
      res.json({ data: { rejected: id } });
    }),
  );

  // ---------------------------------------------------------------------------
  // operations
  // ---------------------------------------------------------------------------
  app.get(
    '/api/admin/dashboard',
    asyncRoute(async (_req, res) => {
      res.json({ data: await getDashboard() });
    }),
  );

  app.get(
    '/api/admin/audit',
    asyncRoute(async (req, res) => {
      res.json({
        data: await listAuditLogs({ limit: Number(req.query.limit ?? 50), offset: Number(req.query.offset ?? 0), ...(req.query.action ? { action: String(req.query.action) } : {}) }),
      });
    }),
  );

  app.get(
    '/api/admin/settings',
    asyncRoute(async (_req, res) => {
      res.json({ data: await getAllSettings() });
    }),
  );

  app.patch(
    '/api/admin/settings/:key',
    idempotency,
    asyncRoute(async (req, res) => {
      await setSetting(req.params.key as string, req.body?.value, (await actorId(req)) ?? undefined);
      res.json({ data: { key: req.params.key, updated: true } });
    }),
  );

  app.post(
    '/api/admin/reconcile/run',
    idempotency,
    asyncRoute(async (_req, res) => {
      res.json({ data: await runReconciliation({}) });
    }),
  );

  app.get(
    '/api/admin/reconcile/findings',
    asyncRoute(async (_req, res) => {
      res.json({ data: await getOpenFindings(50) });
    }),
  );

  app.post(
    '/api/admin/reconcile/findings/:id/resolve',
    idempotency,
    asyncRoute(async (req, res) => {
      await resolveFinding(uuid.parse(req.params.id), (await actorId(req)) ?? 'system');
      res.json({ data: { resolved: req.params.id } });
    }),
  );

  app.get(
    '/api/admin/pbx/jobs',
    asyncRoute(async (_req, res) => {
      res.json({ data: await listRecentJobs(50) });
    }),
  );

  app.get(
    '/api/admin/pbx/compat',
    asyncRoute(async (_req, res) => {
      res.json({ data: await getStoredCompatibilityReport() });
    }),
  );

  app.post(
    '/api/admin/pbx/probe',
    idempotency,
    asyncRoute(async (_req, res) => {
      if (isMockMode()) {
        res.json({ data: { mode: 'mock', note: 'FreePBX is in mock mode; no real probe performed.' } });
        return;
      }
      res.json({ data: await runCompatibilityProbe(new FreePBXGraphQLClient()) });
    }),
  );

  app.post(
    '/api/admin/maintenance/purge-sessions',
    idempotency,
    asyncRoute(async (_req, res) => {
      res.json({ data: { purged: await purgeOldSessions(30) } });
    }),
  );

  // ---------------------------------------------------------------------------
  // Telegram webhook (spec §27: validate the secret token on every request)
  // ---------------------------------------------------------------------------
  const bot = createBot();
  if (bot && env.TELEGRAM_WEBHOOK_SECRET) {
    app.post(
      '/telegram/webhook',
      (req, res, next) => {
        if (req.header('x-telegram-bot-api-secret-token') !== env.TELEGRAM_WEBHOOK_SECRET) {
          logger.warn({ ip: req.ip }, 'rejected telegram webhook call with a bad secret token');
          res.sendStatus(401);
          return;
        }
        next();
      },
      asyncRoute(async (req, res) => {
        await bot.handleUpdate(req.body);
        res.sendStatus(200);
      }),
    );
  }

  // ---------------------------------------------------------------------------
  // 404 + error boundary
  // ---------------------------------------------------------------------------
  app.use((_req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Unknown endpoint' }, requestId: res.locals.requestId });
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const appError = toAppError(err);
    if (appError.code === 'INTERNAL') {
      logger.error({ err: (err as Error)?.stack ?? String(err), requestId: res.locals.requestId }, 'unhandled API error');
    }
    metrics.counters.apiErrors.inc(1, { code: appError.code });
    res.status(appError.httpStatus).json({ error: appError.toJSON(), requestId: res.locals.requestId });
  });

  return app;
}
