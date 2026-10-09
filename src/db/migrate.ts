import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, withTransaction } from './pool.js';
import { logger } from '../lib/logger.js';

/**
 * Minimal, deterministic migration runner.
 *
 * * Every .sql file in /migrations is applied exactly once, in filename order.
 * * A SHA-256 checksum is stored per file; editing an applied migration is a
 *   hard error (prevents silently divergent schemas across environments).
 * * Each migration runs in its own transaction, so a failure leaves the
 *   database at the last good version.
 */

const here = path.dirname(fileURLToPath(import.meta.url));

/** dist/db -> ../../migrations ; src/db -> ../../migrations */
function migrationsDir(): string {
  return path.resolve(here, '..', '..', 'migrations');
}

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

export async function runMigrations(dir = migrationsDir(), log = logger): Promise<MigrationResult> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename    text PRIMARY KEY,
      checksum    text NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now(),
      duration_ms integer NOT NULL DEFAULT 0
    )
  `);

  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const applied: string[] = [];
  const skipped: string[] = [];

  const existing = new Map<string, string>();
  const rows = await pool.query<{ filename: string; checksum: string }>('SELECT filename, checksum FROM schema_migrations');
  for (const r of rows.rows) existing.set(r.filename, r.checksum);

  for (const file of files) {
    const sql = await readFile(path.join(dir, file), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    const prev = existing.get(file);

    if (prev) {
      if (prev !== checksum) {
        throw new Error(
          `Migration ${file} was modified after being applied (checksum mismatch).\n` +
            `Create a new migration instead of editing an applied one.`,
        );
      }
      skipped.push(file);
      continue;
    }

    const t0 = Date.now();
    await withTransaction(async (client) => {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename, checksum, duration_ms) VALUES ($1,$2,$3)', [
        file,
        checksum,
        Date.now() - t0,
      ]);
    });
    applied.push(file);
    log.info({ file, ms: Date.now() - t0 }, 'migration applied');
  }

  return { applied, skipped };
}

/** Verifies the audit-log hash chain. Returns the first broken row id, if any. */
export async function verifyAuditChain(): Promise<{ ok: boolean; brokenAtId?: number; checked: number }> {
  const res = await pool.query<{ id: string; prev_hash: string | null; row_hash: string | null; expected: string }>(`
    SELECT id, prev_hash, row_hash,
           encode(digest(
             coalesce(lag(row_hash) OVER (ORDER BY id), '')
             || action
             || coalesce(target_type,'')
             || coalesce(target_id::text,'')
             || coalesce(target_ref,'')
             || result
             || coalesce(reason,'')          -- migration 011 added reason to the chain
             || coalesce(actor_id::text,'')
             || coalesce(metadata::text,'')
             || created_at::text
           , 'sha256'), 'hex') AS expected
    FROM audit_logs
    ORDER BY id
  `);
  const broken = res.rows.find((r) => r.row_hash !== r.expected);
  return { ok: !broken, brokenAtId: broken ? Number(broken.id) : undefined, checked: res.rowCount ?? 0 };
}
