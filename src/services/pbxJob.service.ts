import type { DbClient } from '../db/pool.js';
import { many, query } from '../db/pool.js';
import { logger } from '../lib/logger.js';

/**
 * Durable queue for FreePBX side effects (spec §31, §36).
 *
 * Every mutation we intend to perform on the PBX is recorded BEFORE the HTTP
 * call and updated after it. That single design decision is what makes the
 * "FreePBX succeeded but the database write failed" case recoverable:
 * the reconciler can read the job + route mapping and converge reality, instead
 * of leaving a DID routed to a dead extension.
 */

export type SyncJobType =
  | 'EXTENSION_CREATE'
  | 'EXTENSION_UPDATE'
  | 'EXTENSION_DELETE'
  | 'ROUTE_CREATE'
  | 'ROUTE_UPDATE'
  | 'ROUTE_DELETE'
  | 'ROUTE_VERIFY'
  | 'EXTENSION_VERIFY'
  | 'CDR_FETCH'
  | 'LIVE_CALLS_FETCH';

export type SyncEntityType = 'number' | 'assignment' | 'sip_account' | 'route' | 'user' | 'system';

export interface EnqueueJobInput {
  jobType: SyncJobType;
  entityType: SyncEntityType;
  entityId?: string | null;
  payload?: Record<string, unknown>;
  /** Stable key so a retry cannot duplicate the operation. */
  idempotencyKey: string;
  priority?: number;
  maxAttempts?: number;
  client?: DbClient;
}

export interface SyncJobRow {
  id: string;
  job_type: SyncJobType;
  entity_type: SyncEntityType;
  entity_id: string | null;
  payload: Record<string, unknown>;
  idempotency_key: string;
  status: 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'DEAD' | 'CANCELLED';
  attempts: number;
  max_attempts: number;
  priority: number;
  next_run_at: Date;
  last_error: string | null;
  result: Record<string, unknown> | null;
  created_at: Date;
  finished_at: Date | null;
}

export async function enqueueJob(input: EnqueueJobInput): Promise<string> {
  const sql = `
    INSERT INTO freepbx_sync_jobs (job_type, entity_type, entity_id, payload, idempotency_key, priority, max_attempts)
    VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7)
    ON CONFLICT (idempotency_key) DO UPDATE SET
      payload = EXCLUDED.payload,
      status = CASE WHEN freepbx_sync_jobs.status IN ('SUCCEEDED','RUNNING') THEN freepbx_sync_jobs.status ELSE 'PENDING' END,
      next_run_at = CASE WHEN freepbx_sync_jobs.status IN ('SUCCEEDED','RUNNING') THEN freepbx_sync_jobs.next_run_at ELSE now() END
    RETURNING id
  `;
  const params = [
    input.jobType,
    input.entityType,
    input.entityId ?? null,
    JSON.stringify(input.payload ?? {}),
    input.idempotencyKey,
    input.priority ?? 100,
    input.maxAttempts ?? 5,
  ];
  const exec = input.client ? input.client.query.bind(input.client) : query;
  const res = await exec(sql, params as never[]);
  const id = (res.rows[0] as { id: string }).id;
  logger.debug({ jobType: input.jobType, idempotencyKey: input.idempotencyKey }, 'pbx sync job enqueued');
  return id;
}

/** Marks a job as finished (success or failure). Called by the executor. */
export async function completeJob(
  id: string,
  outcome: { ok: true; result?: Record<string, unknown> } | { ok: false; error: string; retryable: boolean },
): Promise<void> {
  if (outcome.ok) {
    await query(
      `UPDATE freepbx_sync_jobs
          SET status = 'SUCCEEDED', result = $2::jsonb, finished_at = now(), last_error = NULL
        WHERE id = $1`,
      [id, JSON.stringify(outcome.result ?? {})],
    );
    return;
  }

  await query(
    `UPDATE freepbx_sync_jobs
        SET attempts = attempts + 1,
            status = CASE
                       WHEN $3 AND attempts + 1 < max_attempts THEN 'FAILED'
                       ELSE CASE WHEN $3 THEN 'DEAD' ELSE 'DEAD' END
                     END,
            last_error = $2,
            next_run_at = CASE WHEN $3 AND attempts + 1 < max_attempts
                               THEN now() + (interval '30 seconds' * power(2, attempts))
                               ELSE next_run_at END,
            finished_at = CASE WHEN NOT ($3 AND attempts + 1 < max_attempts) THEN now() ELSE NULL END
      WHERE id = $1`,
    [id, outcome.error, outcome.retryable],
  );
}

/** Claims up to `limit` due jobs atomically (SKIP LOCKED keeps workers parallel-safe). */
export async function claimDueJobs(limit = 10, workerName = 'worker'): Promise<SyncJobRow[]> {
  return many<SyncJobRow>(
    `WITH due AS (
       SELECT id FROM freepbx_sync_jobs
        WHERE status IN ('PENDING','FAILED') AND next_run_at <= now()
        ORDER BY priority ASC, next_run_at ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED
     )
     UPDATE freepbx_sync_jobs j
        SET status = 'RUNNING', locked_at = now(), locked_by = $2
       FROM due
      WHERE j.id = due.id
      RETURNING j.*`,
    [limit, workerName],
  );
}

export async function listRecentJobs(limit = 10): Promise<SyncJobRow[]> {
  return many<SyncJobRow>('SELECT * FROM freepbx_sync_jobs ORDER BY created_at DESC LIMIT $1', [limit]);
}

export async function countJobs(statuses: SyncJobRow['status'][]): Promise<number> {
  const res = await query<{ count: string }>(
    `SELECT count(*)::text AS count FROM freepbx_sync_jobs WHERE status = ANY($1::text[])`,
    [statuses],
  );
  return Number(res.rows[0]?.count ?? 0);
}

/**
 * Releases jobs stuck in RUNNING (a worker crashed mid-flight). The reconciler
 * calls this so no job is ever lost.
 */
export async function requeueStuckJobs(olderThanMinutes = 15): Promise<number> {
  const res = await query(
    `UPDATE freepbx_sync_jobs
        SET status = 'FAILED',
            last_error = 'requeued after worker timeout',
            next_run_at = now()
      WHERE status = 'RUNNING' AND locked_at < now() - ($1 || ' minutes')::interval`,
    [String(olderThanMinutes)],
  );
  const count = res.rowCount ?? 0;
  if (count > 0) logger.warn({ count }, 'requeued stuck pbx sync jobs');
  return count;
}
