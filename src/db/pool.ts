import pg from 'pg';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

const { Pool, types } = pg;

/**
 * PostgreSQL access layer.
 *
 * Design notes
 * ------------
 * * Raw `pg` (no ORM): number assignment and routing need precise control over
 *   `SELECT ... FOR UPDATE SKIP LOCKED`, transaction-scoped advisory locks and
 *   savepoints. ORMs hide exactly those primitives (spec §14, §39).
 * * INT8 (bigint, oid 20) is returned as a JS number because Telegram IDs and
 *   counters fit comfortably in a double; anything larger must be cast in SQL.
 * * NUMERIC (1700) stays a string to avoid silent precision loss on money.
 */
types.setTypeParser(20, (v: string) => Number(v));
types.setTypeParser(1700, (v: string) => v);

/**
 * Translates libpq-style `sslmode=` on the connection string into an explicit
 * tls config. Recent `pg` releases switched `sslmode=require` to VERIFY the
 * certificate chain (libpq's old `verify-ca` semantics), which breaks managed
 * databases that present their own CA (e.g. Aiven: "self-signed certificate in
 * certificate chain"). libpq semantics are restored here:
 *  - disable                        → no TLS
 *  - allow / prefer / require       → TLS, no certificate verification
 *  - verify-ca / verify-full        → TLS with CA verification
 * The parameter is stripped from the string so it never fights the explicit
 * `ssl` option, and the local docker/test database (no sslmode) is untouched.
 */
export function sslFromConnectionString(raw: string): { connectionString: string; ssl?: { rejectUnauthorized: boolean } } {
  if (!/[?&]sslmode=/.test(raw)) return { connectionString: raw };
  const url = new URL(raw);
  const mode = (url.searchParams.get('sslmode') ?? 'prefer').toLowerCase();
  url.searchParams.delete('sslmode');
  const connectionString = url.toString();
  if (mode === 'disable') return { connectionString };
  return { connectionString, ssl: { rejectUnauthorized: mode.startsWith('verify') } };
}

const { connectionString, ssl } = sslFromConnectionString(env.DATABASE_URL);

/**
 * Cloud databases (Aiven's lb specifically) drop long-idle TCP connections.
 * Without keepalives the pool happily checks out a kernel-dead socket and the
 * FIRST statement on it dies with `read ECONNRESET` - which killed a user's
 * Telegram update live on 2026-10-08. Fix has two layers:
 *  1. TCP keepalives so the pool's sockets are exercised before a proxy can
 *     reap them for idleness;
 *  2. `isTransientPgConnectionError` + one retry at the query/transaction
 *     boundary for the connection blips that still happen (network flap,
 *     failover, maintenance restart).
 */
export const pool = new Pool({
  connectionString,
  ...(ssl ? { ssl } : {}),
  max: env.PGPOOL_MAX,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10_000,
  statement_timeout: env.PG_STATEMENT_TIMEOUT_MS,
  application_name: 'sipbot',
});

/**
 * Transport-level connection failures that mean "the statement never reached
 * the server" (socket was reset/refused before or while writing). These are
 * safe to REISSUE - unlike SQL errors, they are pre-execution.
 */
export function isTransientPgConnectionError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  if (code && ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EHOSTUNREACH'].includes(code)) return true;
  const msg = (err as Error).message ?? '';
  return /connection terminated unexpectedly|server closed the connection|read ECONNRESET|write ECONNRESET|Connection ended/i.test(msg);
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

pool.on('error', (err) => {
  // A backend crash must not kill the process; the pool replaces the client.
  logger.error({ err: err.message }, 'idle postgres client error');
});

export type DbClient = pg.PoolClient;
export type Queryable = Pick<DbClient, 'query'>;

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  sql: string,
  params: unknown[] = [],
): Promise<pg.QueryResult<T>> {
  try {
    return await pool.query<T>(sql, params as never[]);
  } catch (err) {
    // A reset socket never delivered the statement; one quiet retry makes the
    // cloud-DB blip invisible to the user instead of crashing their tap.
    // (Multi-statement writes run inside withTransaction, which has stricter
    // and atomic retry semantics.)
    if (!isTransientPgConnectionError(err)) throw err;
    logger.warn({ err: (err as Error).message }, 'transient postgres connection error; retrying once');
    await sleep(250);
    return pool.query<T>(sql, params as never[]);
  }
}

export async function one<T extends pg.QueryResultRow = pg.QueryResultRow>(
  sql: string,
  params: unknown[] = [],
): Promise<T | null> {
  const res = await query<T>(sql, params);
  return (res.rows[0] as T | undefined) ?? null;
}

export async function oneOrThrow<T extends pg.QueryResultRow = pg.QueryResultRow>(
  sql: string,
  params: unknown[] = [],
  what = 'Row',
): Promise<T> {
  const row = await one<T>(sql, params);
  if (!row) throw new Error(`${what} not found`);
  return row;
}

export async function many<T extends pg.QueryResultRow = pg.QueryResultRow>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const res = await query<T>(sql, params);
  return res.rows as T[];
}

export async function scalar<T = unknown>(sql: string, params: unknown[] = []): Promise<T | null> {
  const row = await one(sql, params);
  if (!row) return null;
  const values = Object.values(row);
  return (values[0] as T) ?? null;
}

export interface TxOptions {
  /** 'SERIALIZABLE' gives the strongest guard; default is REPEATABLE READ for allocations. */
  isolation?: 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE';
  readOnly?: boolean;
  /** Optional lock_timeout in ms so a hot row cannot stall the bot. */
  lockTimeoutMs?: number;
}

/**
 * Runs `fn` inside a database transaction with automatic commit/rollback.
 *
 * Retries once on 40001 (serialization_failure) and 40P01 (deadlock_detected),
 * which is the documented correct behaviour for SERIALIZABLE/REPEATABLE READ.
 */
export async function withTransaction<T>(
  fn: (client: DbClient) => Promise<T>,
  options: TxOptions = {},
): Promise<T> {
  const { isolation = 'READ COMMITTED', readOnly = false, lockTimeoutMs } = options;
  const maxAttempts = 3;

  for (let attempt = 1; ; attempt += 1) {
    let client: DbClient;
    try {
      client = await pool.connect();
    } catch (err) {
      if (isTransientPgConnectionError(err) && attempt < maxAttempts) {
        logger.warn({ attempt, err: (err as Error).message }, 'could not acquire a postgres client; retrying');
        await sleep(200 * attempt);
        continue;
      }
      throw err;
    }
    let released = false;
    try {
      try {
        await client.query(`BEGIN ISOLATION LEVEL ${isolation}${readOnly ? ' READ ONLY' : ''}`);
        if (lockTimeoutMs) {
          await client.query(`SET LOCAL lock_timeout = ${Math.max(1, Math.floor(lockTimeoutMs))}`);
        }
      } catch (err) {
        // BEGIN on a freshly-reset socket: nothing is open yet, the whole
        // client goes back dead and the transaction can start over safely.
        if (isTransientPgConnectionError(err) && attempt < maxAttempts) {
          logger.warn({ attempt, err: (err as Error).message }, 'connection died before BEGIN; retrying transaction');
          client.release(err as Error);
          released = true;
          await sleep(200 * attempt);
          continue;
        }
        throw err;
      }
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* connection already gone; nothing to roll back */
      }
      const code = (err as { code?: string }).code;
      const retryable = code === '40001' || code === '40P01';
      if (retryable && attempt < maxAttempts) {
        logger.warn({ code, attempt }, 'retrying transaction after serialization failure');
        continue;
      }
      throw err;
    } finally {
      if (!released) client.release();
    }
  }
}

/**
 * Transaction-scoped advisory lock. Serialises a logical resource (e.g. the
 * "which extension is free" decision) without locking rows the caller does not
 * own. Released automatically at COMMIT/ROLLBACK.
 */
export async function withAdvisoryLock<T>(
  client: DbClient,
  lockKey: number,
  fn: () => Promise<T>,
): Promise<T> {
  await client.query('SELECT pg_advisory_xact_lock($1)', [lockKey]);
  return fn();
}

/** Well-known advisory lock keys (must be stable integers). */
export const LOCK_KEYS = {
  EXTENSION_POOL: 918_273_645,
  NUMBER_ALLOCATION: 918_273_646,
  REFERRAL_CREDIT: 918_273_647,
  SETTINGS_CACHE: 918_273_648,
} as const;

export async function healthcheck(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const t0 = Date.now();
  try {
    await query('SELECT 1');
    return { ok: true, latencyMs: Date.now() - t0 };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - t0, error: (err as Error).message };
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}
