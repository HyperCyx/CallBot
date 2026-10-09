import { claimDueJobs, completeJob, type SyncJobRow } from '../services/pbxJob.service.js';
import { getFreePBX } from '../freepbx/index.js';
import { logger } from '../lib/logger.js';
import { FreePBXError } from '../freepbx/types.js';
import { ingestCdrs, refreshLiveSessions } from '../services/call.service.js';
import { verifyRouteMapping } from '../services/routing.service.js';
import { one, query } from '../db/pool.js';

/**
 * Executes queued FreePBX sync jobs.
 *
 * Most PBX mutations are performed inline by the services (with the job row
 * acting as the durable intent record). This executor handles the jobs that are
 * genuinely deferred:
 *
 *   ROUTE_VERIFY / EXTENSION_VERIFY - confirm reality after a failure
 *   ROUTE_DELETE                    - remove a route that could not be removed
 *   CDR_FETCH                       - scheduled historical call ingestion
 *   LIVE_CALLS_FETCH                - scheduled live-call snapshot
 *
 * It is safe to run several instances: jobs are claimed with SKIP LOCKED.
 */

export async function processJobs(limit = 10, workerName = `worker-${process.pid}`): Promise<number> {
  const jobs = await claimDueJobs(limit, workerName);
  for (const job of jobs) {
    await executeJob(job);
  }
  return jobs.length;
}

async function executeJob(job: SyncJobRow): Promise<void> {
  const pbx = getFreePBX();
  try {
    switch (job.job_type) {
      case 'ROUTE_VERIFY': {
        const mappingId = (job.payload.mappingId as string | undefined) ?? null;
        if (!mappingId) {
          const mapping = await one<{ id: string }>(
            `SELECT id FROM inbound_route_mappings WHERE assignment_id = $1 OR number_id = $2 ORDER BY created_at DESC LIMIT 1`,
            [job.entity_id, job.payload.numberId ?? null],
          );
          if (!mapping) {
            await completeJob(job.id, { ok: false, error: 'no mapping found to verify', retryable: false });
            return;
          }
          const row = await one<Record<string, unknown>>('SELECT * FROM inbound_route_mappings WHERE id = $1', [mapping.id]);
          const result = await verifyRouteMapping(row as never);
          await completeJob(job.id, { ok: true, result: { state: result.state, detail: result.detail } });
          return;
        }
        const row = await one<Record<string, unknown>>('SELECT * FROM inbound_route_mappings WHERE id = $1', [mappingId]);
        if (!row) {
          await completeJob(job.id, { ok: false, error: 'mapping not found', retryable: false });
          return;
        }
        const result = await verifyRouteMapping(row as never);
        await completeJob(job.id, { ok: true, result: { state: result.state, detail: result.detail } });
        return;
      }

      case 'EXTENSION_VERIFY': {
        const extension = String(job.payload.extension ?? '');
        const ext = extension ? await pbx.getExtension(extension) : null;
        await completeJob(job.id, { ok: true, result: { exists: Boolean(ext) } });
        return;
      }

      case 'ROUTE_DELETE': {
        const routeId = String(job.payload.routeId ?? '');
        if (!routeId) {
          await completeJob(job.id, { ok: false, error: 'routeId missing', retryable: false });
          return;
        }
        try {
          await pbx.deleteInboundRoute(routeId);
          await completeJob(job.id, { ok: true, result: { deleted: routeId } });
        } catch (err) {
          if (err instanceof FreePBXError && err.kind === 'NOT_FOUND') {
            await completeJob(job.id, { ok: true, result: { alreadyGone: routeId } });
            return;
          }
          throw err;
        }
        return;
      }

      case 'CDR_FETCH': {
        const result = await ingestCdrs({ maxPages: 5 });
        await completeJob(job.id, { ok: true, result: result as unknown as Record<string, unknown> });
        return;
      }

      case 'LIVE_CALLS_FETCH': {
        const calls = await refreshLiveSessions();
        await completeJob(job.id, { ok: true, result: { active: calls.length } });
        return;
      }

      case 'EXTENSION_CREATE':
      case 'EXTENSION_UPDATE':
      case 'EXTENSION_DELETE':
      case 'ROUTE_CREATE':
      case 'ROUTE_UPDATE': {
        // These are completed inline by the service that performed them. If one
        // is still PENDING here it means the process died mid-flight: verify
        // reality rather than blindly repeating a non-idempotent mutation.
        await requeueAsVerification(job);
        return;
      }

      default: {
        await completeJob(job.id, { ok: false, error: `unsupported job type ${job.job_type}`, retryable: false });
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const retryable = !(err instanceof FreePBXError) || err.retryable;
    await completeJob(job.id, { ok: false, error: message, retryable });
    logger.warn({ jobId: job.id, jobType: job.job_type, err: message, retryable }, 'pbx sync job failed');
  }
}

/**
 * Converts a mutation job left behind by a crashed process into a verification
 * job. This is how "FreePBX succeeded but the DB write failed" and "we don't
 * know whether it succeeded" are both resolved without duplicating mutations.
 */
async function requeueAsVerification(job: SyncJobRow): Promise<void> {
  const verifyType = job.job_type.startsWith('ROUTE') ? 'ROUTE_VERIFY' : 'EXTENSION_VERIFY';
  await query(
    `INSERT INTO freepbx_sync_jobs (job_type, entity_type, entity_id, payload, idempotency_key, priority)
     VALUES ($1,$2,$3,$4::jsonb,$5,50)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [
      verifyType,
      job.entity_type,
      job.entity_id,
      JSON.stringify({ ...job.payload, origin: job.job_type, originJobId: job.id }),
      `verify-from-${job.job_type}:${job.id}`,
    ],
  );
  await completeJob(job.id, { ok: true, result: { convertedTo: verifyType } });
  logger.warn({ jobId: job.id, jobType: job.job_type }, 'crashed mutation job converted into a verification job');
}
