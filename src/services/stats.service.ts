import { many, one, query } from '../db/pool.js';
import { countNumbersByStatus } from './inventory.service.js';
import { getUserCounts } from './user.service.js';
import { getLiveCalls, getCallsTodayCount } from './call.service.js';
import { countJobs } from './pbxJob.service.js';
import { getReferralProgramSummary } from './referral.service.js';
import { metrics } from '../lib/metrics.js';
import { logger } from '../lib/logger.js';

/**
 * Admin dashboard aggregates (spec §24) and metric gauge refresh (spec §38).
 */

export interface DashboardData {
  users: { total: number; active: number; pending: number; blocked: number; expired: number; premium: number };
  numbers: Record<string, number>;
  liveCalls: number;
  callsToday: number;
  referral: { pendingCents: number; paidCents: number; qualified: number };
  health: {
    pendingPbxJobs: number;
    deadPbxJobs: number;
    criticalFindings: number;
    lastReconcileAt: Date | null;
    lastCdrSyncAt: Date | null;
    amiConnected: boolean;
    dbLatencyMs: number;
  };
}

export async function getDashboard(): Promise<DashboardData> {
  const [users, numbers, live, today, referral, pendingJobs, deadJobs, findings, reconcile, cdrState] = await Promise.all([
    getUserCounts(),
    countNumbersByStatus(),
    getLiveCalls(),
    getCallsTodayCount(),
    getReferralProgramSummary(),
    countJobs(['PENDING', 'FAILED']),
    countJobs(['DEAD']),
    one<{ count: string }>(`SELECT count(*)::text AS count FROM reconciliation_findings WHERE resolved_at IS NULL AND severity = 'CRITICAL'`),
    one<{ started_at: Date; auto_fixed_count: number }>('SELECT started_at FROM reconciliation_runs ORDER BY started_at DESC LIMIT 1'),
    one<{ last_synced_at: Date | null }>('SELECT last_synced_at FROM cdr_sync_state WHERE id = $1', ['default']),
  ]);

  const dbLatencyStart = Date.now();
  await query('SELECT 1');
  const dbLatencyMs = Date.now() - dbLatencyStart;

  const { liveCallSourceStatus } = await import('./call.service.js');
  const ami = await liveCallSourceStatus();

  // Publish gauges so /metrics reflects reality without extra queries (§38).
  metrics.gauges.numbersAvailable.set(numbers.AVAILABLE ?? 0);
  metrics.gauges.numbersAssigned.set(numbers.ASSIGNED ?? 0);
  metrics.gauges.activeUsers.set(users.active);
  metrics.gauges.liveCalls.set(live.length);
  metrics.gauges.openFindings.set(Number(findings?.count ?? 0));
  metrics.histograms.dbLatencyMs.observe(dbLatencyMs, { op: 'dashboard' });

  return {
    users,
    numbers: numbers as unknown as Record<string, number>,
    liveCalls: live.length,
    callsToday: today,
    referral: {
      pendingCents: referral.pendingCommissionsCents,
      paidCents: referral.paidCents,
      qualified: referral.qualified,
    },
    health: {
      pendingPbxJobs: pendingJobs,
      deadPbxJobs: deadJobs,
      criticalFindings: Number(findings?.count ?? 0),
      lastReconcileAt: reconcile?.started_at ?? null,
      lastCdrSyncAt: cdrState?.last_synced_at ?? null,
      amiConnected: ami.available,
      dbLatencyMs,
    },
  };
}

export async function getInventoryBreakdown(limit = 10): Promise<
  Array<{ country: string; flag: string | null; service: string; plan_type: string; available: number; assigned: number; suspended: number }>
> {
  const rows = await many<{
    country: string;
    flag: string | null;
    service: string;
    plan_type: string;
    available: string;
    assigned: string;
    suspended: string;
  }>(
    `SELECT c.name AS country, c.flag, s.name AS service, n.plan_type,
            count(*) FILTER (WHERE n.status = 'AVAILABLE')::text AS available,
            count(*) FILTER (WHERE n.status = 'ASSIGNED')::text AS assigned,
            count(*) FILTER (WHERE n.status = 'SUSPENDED')::text AS suspended
       FROM numbers n
       JOIN countries c ON c.id = n.country_id
       JOIN services s ON s.id = n.service_id
      WHERE n.deleted_at IS NULL
      GROUP BY c.name, c.flag, s.name, n.plan_type
      ORDER BY count(*) DESC
      LIMIT $1`,
    [limit],
  );
  return rows.map((r) => ({
    country: r.country,
    flag: r.flag,
    service: r.service,
    plan_type: r.plan_type,
    available: Number(r.available),
    assigned: Number(r.assigned),
    suspended: Number(r.suspended),
  }));
}

/** Formats cents as a human string. */
export function formatMoney(cents: number, currency = 'USD'): string {
  const symbols: Record<string, string> = { EUR: '€', USD: '$', GBP: '£' };
  const symbol = symbols[currency] ?? `${currency} `;
  return `${symbol}${(cents / 100).toFixed(2)}`;
}

export function logStartupSummary(): void {
  logger.info('sipbot services ready');
}
