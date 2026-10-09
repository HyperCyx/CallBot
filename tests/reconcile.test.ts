import { describe, expect, it, vi } from 'vitest';
import { FreePBXError } from '../src/freepbx/types.js';
import { verifyRouteMapping } from '../src/services/routing.service.js';
import { many, one, query } from '../src/db/pool.js';
import { assignNumber } from '../src/services/assignment.service.js';
import { getOpenFindings, resolveFinding, runReconciliation } from '../src/workers/reconcile.worker.js';
import { addNumbersToInventory, auditActions, createSipAccount, createUser, getCountryId, getNumberRow, getRouteForNumber, getServiceId, mockPbx } from './helpers.js';

/**
 * Reconciliation worker (spec §26).
 *
 * The contract under test is a policy, not just behaviour:
 *   * additive, unambiguous drift is repaired automatically (route missing,
 *     route re-pointed, stuck reservation, stuck assignment);
 *   * anything destructive or ambiguous is REPORTED for an admin and never
 *     applied by the worker (stale routes are never deleted, an extension that
 *     disappeared from the PBX is never recreated blindly).
 */

let nextExtension = 10123;

async function assignedNumber(extension?: string) {
  const user = await createUser();
  // A distinct extension per test: the extension pool is unique and truncated
  // rows would otherwise collide with a previous test's allocation.
  await createSipAccount(user.id, extension ?? String(nextExtension++));
  await addNumbersToInventory({ count: 1 });
  const result = await assignNumber({ userId: user.id, countryId: await getCountryId(), serviceId: await getServiceId() });
  return { user, ...result };
}

describe('reconciliation: automatic repair of safe drift (spec §26)', () => {
  it('recreates an inbound route that disappeared from the PBX', async () => {
    const assigned = await assignedNumber();
    const mapping = await getRouteForNumber(assigned.numberId);
    expect(mapping?.freepbx_route_id).toBeTruthy();

    // Out-of-band change: someone deleted the route in the FreePBX GUI.
    await mockPbx().deleteInboundRoute(mapping!.freepbx_route_id!);
    expect(await mockPbx().getAllInboundRoutes()).toHaveLength(0);

    const summary = await runReconciliation({ autoFix: true, alert: false });
    expect(summary.autoFixed).toBeGreaterThanOrEqual(1);
    expect(summary.details.some((d) => d.type === 'ROUTE_MISSING_IN_PBX')).toBe(true);

    // The route exists again, and the mapping is back in sync.
    const routes = await mockPbx().getAllInboundRoutes();
    expect(routes).toHaveLength(1);
    const repaired = await getRouteForNumber(assigned.numberId);
    expect(repaired?.drift_state).toBe('OK');
    expect(repaired?.status).toBe('ACTIVE');
    expect(await auditActions()).toContain('RECONCILIATION_FIX_APPLIED');
  });

  it('re-points a route that drifted to the wrong extension', async () => {
    const assigned = await assignedNumber('10124');
    const mapping = await getRouteForNumber(assigned.numberId);

    // Someone edited the route DESTINATION in the GUI (the DID/extension stays
    // the same - that is what "points at the wrong extension" means in FreePBX).
    await mockPbx().updateInboundRoute({
      oldExtension: mapping!.did_match_pattern,
      oldCidnum: '',
      extension: mapping!.did_match_pattern,
      cidnum: '',
      destination: 'from-did-direct,99999,1',
      description: 'manual edit',
    });

    const summary = await runReconciliation({ autoFix: true, alert: false });
    expect(summary.details.some((d) => d.type === 'ROUTE_DESTINATION_MISMATCH')).toBe(true);

    // The route now points at the correct extension again...
    const route = await mockPbx().getInboundRoute(mapping!.freepbx_route_id!);
    expect(route?.destinationConnection ?? '').toContain('10124');
    // ...and the drift is cleared on the mapping row.
    expect((await getRouteForNumber(assigned.numberId))?.drift_state).toBe('OK');
  });

  it('releases a reservation left behind by a crashed assignment', async () => {
    const user = await createUser();
    await createSipAccount(user.id, '10125');
    void user;
    const [numberId] = await addNumbersToInventory({ count: 1 });

    // Simulate the crash window: number RESERVED with an expired TTL and no
    // assignment row that could ever complete.
    await query(
      "UPDATE numbers SET status = 'RESERVED', reserved_at = now() - interval '20 minutes', reservation_expires_at = now() - interval '1 minute' WHERE id = $1",
      [numberId],
    );

    const summary = await runReconciliation({ autoFix: true, alert: false });
    expect(summary.details).toBeDefined();
    expect((await getNumberRow(numberId!))?.status).toBe('AVAILABLE');
  });

  it('is idempotent: a second run finds nothing to fix', async () => {
    await assignedNumber('10126');
    const first = await runReconciliation({ autoFix: true, alert: false });
    const second = await runReconciliation({ autoFix: true, alert: false });
    expect(first.autoFixed).toBe(0);
    expect(second.autoFixed).toBe(0);
    expect(second.findings).toBe(0);
  });
});

describe('reconciliation: destructive or ambiguous drift is reported, never applied', () => {
  it('never deletes a route it does not own', async () => {
    await assignedNumber('10127');
    // A manually managed route (e.g. for a different trunk) exists on the PBX.
    await mockPbx().createInboundRoute({ extension: '971509999999', cidnum: '', destination: 'from-did-direct,100,1', description: 'manual' });
    const before = (await mockPbx().getAllInboundRoutes()).length;

    const summary = await runReconciliation({ autoFix: true, alert: false });
    expect(summary.details.some((d) => d.type === 'STALE_ROUTE_IN_PBX')).toBe(true);
    // Untouched: removing someone else's route requires an admin decision.
    expect((await mockPbx().getAllInboundRoutes()).length).toBe(before);
  });

  it('reports an extension that vanished from the PBX without recreating it', async () => {
    const assigned = await assignedNumber('10128');
    await mockPbx().deleteExtension('10128');
    const extensionsBefore = (await mockPbx().getAllExtensions()).length;

    const summary = await runReconciliation({ autoFix: true, alert: false });
    expect(summary.details.some((d) => d.type === 'EXTENSION_MISSING_IN_PBX')).toBe(true);
    expect(summary.critical).toBeGreaterThanOrEqual(1);
    // A deleted extension may have been removed for a reason (fraud, migration);
    // the worker must not silently re-create it.
    expect((await mockPbx().getAllExtensions()).length).toBe(extensionsBefore);
    // The number stays assigned: an admin resolves this, not the worker.
    expect((await getNumberRow(assigned.numberId))?.status).toBe('ASSIGNED');
  });

  it('exposes open findings for the admin panel and can resolve them', async () => {
    const assigned = await assignedNumber('10129');
    await mockPbx().deleteExtension('10129');
    const summary = await runReconciliation({ autoFix: true, alert: false });

    const findings = await getOpenFindings(20);
    expect(findings.length).toBeGreaterThanOrEqual(summary.critical);
    const target = findings.find((f) => f.finding_type === 'EXTENSION_MISSING_IN_PBX');
    expect(target).toBeTruthy();
    expect(target?.severity).toBe('CRITICAL');
    expect(target?.auto_fixable).toBe(false);
    expect(String(target?.detail)).toContain('10129');

    const admin = await createUser({ telegramId: 800001 });
    await resolveFinding(String(target!.id), admin.id);
    const after = await getOpenFindings(20);
    expect(after.find((f) => f.id === target!.id)).toBeUndefined();
    expect((await getNumberRow(assigned.numberId))?.status).toBe('ASSIGNED');
  });
});

describe('reconciliation: run bookkeeping and failure handling', () => {
  it('records every run with its counters', async () => {
    await assignedNumber('10130');
    const summary = await runReconciliation({ autoFix: true, alert: false });

    const run = await one<{ status: string; finished_at: Date | null; extensions_seen: number; routes_seen: number; findings_count: number; auto_fixed_count: number }>(
      'SELECT status, finished_at, extensions_seen, routes_seen, findings_count, auto_fixed_count FROM reconciliation_runs WHERE id = $1',
      [summary.runId],
    );
    expect(run?.status).toBe('COMPLETED');
    expect(run?.finished_at).toBeInstanceOf(Date);
    expect(run?.extensions_seen).toBe(summary.extensionsSeen);
    expect(run?.routes_seen).toBe(summary.routesSeen);
    expect(await auditActions()).toContain('RECONCILIATION_RUN');
  });

  it('marks the run FAILED when the PBX is unreachable, and changes nothing', async () => {
    const assigned = await assignedNumber('10131');
    mockPbx().failNextOperation('fetchAllExtensions', 1, 'pbx down', 'NETWORK');

    await expect(runReconciliation({ autoFix: true, alert: false })).rejects.toThrow();

    const failed = await one<{ status: string; error: string | null }>(
      "SELECT status, error FROM reconciliation_runs WHERE status = 'FAILED' ORDER BY started_at DESC LIMIT 1",
    );
    expect(failed?.status).toBe('FAILED');
    expect(failed?.error).toBeTruthy();

    // Nothing was mutated, and the route is still in place.
    expect((await getNumberRow(assigned.numberId))?.status).toBe('ASSIGNED');
    expect(await mockPbx().getAllInboundRoutes()).toHaveLength(1);
  });

  it('keeps the PBX inventory snapshot, replacing it on each run', async () => {
    await assignedNumber('10132');
    await runReconciliation({ autoFix: true, alert: false });
    const first = await many<{ kind: string }>('SELECT kind FROM pbx_inventory_snapshot');
    await runReconciliation({ autoFix: true, alert: false });
    const second = await many<{ kind: string }>('SELECT kind FROM pbx_inventory_snapshot');
    // No duplicates accumulate across runs.
    expect(second.length).toBe(first.length);
    expect(second.some((r) => r.kind === 'INBOUND_ROUTE')).toBe(true);
  });
});

describe('reconciliation: live-PBX failure modes must not kill the run (2026-10-08 incident)', () => {
  it('a 500 on the by-id route read becomes MISSING via list membership, never a run failure', async () => {
    const assigned = await assignedNumber();
    const mapping = await getRouteForNumber(assigned.numberId);

    // The live Sangoma build answered inboundRoute(id:) with a GraphQL
    // "Internal server error" for a deleted route instead of null.
    const pbx = mockPbx();
    const byId = vi.spyOn(pbx, 'getInboundRoute').mockRejectedValue(
      new FreePBXError('FreePBX inboundRoute returned GraphQL errors', 'GRAPHQL', {
        errors: [{ message: 'Internal server error', path: ['inboundRoute', 'id'] }],
      }),
    );
    // Delete the route out-of-band: the reported state must come from the
    // list read, and the run must finish instead of throwing.
    await pbx.deleteInboundRoute(mapping!.freepbx_route_id!);

    const summary = await runReconciliation({ autoFix: true, alert: false });
    expect(summary.details.some((d) => d.type === 'ROUTE_MISSING_IN_PBX')).toBe(true);
    expect(summary.autoFixed).toBeGreaterThanOrEqual(1);
    byId.mockRestore();
  });

  it('a route gone from the PBX whose OWNER is deleted is reported stale, never auto-recreated', async () => {
    const assigned = await assignedNumber();
    const mapping = await getRouteForNumber(assigned.numberId);
    const pbx = mockPbx();
    await pbx.deleteInboundRoute(mapping!.freepbx_route_id!);
    // Orphan it: owner account deleted out-of-band (the fixture leak).
    await query("UPDATE users SET status = 'DELETED', deleted_at = now() WHERE id = $1", [assigned.user.id]);

    const summary = await runReconciliation({ autoFix: true, alert: false });
    expect(summary.details.some((d) => d.type === 'ROUTE_STALE_ORPHANED')).toBe(true);
    expect(summary.details.some((d) => d.type === 'ROUTE_RECREATE_FAILED')).toBe(false);
    // No ghost route got recreated towards the deleted user's extension.
    expect((await pbx.getAllInboundRoutes()).filter((r) => r.id === mapping!.freepbx_route_id)).toHaveLength(0);
  });

  it('standalone verification with all route reads failing reports UNAVAILABLE - uncertainty, not destruction', async () => {
    const assigned = await assignedNumber();
    const mapping = await getRouteForNumber(assigned.numberId);
    const pbx = mockPbx();
    const list = vi.spyOn(pbx, 'getAllInboundRoutes').mockRejectedValue(new Error('upstream 502'));
    const byId = vi.spyOn(pbx, 'getInboundRoute').mockRejectedValue(
      new FreePBXError('FreePBX inboundRoute returned GraphQL errors', 'GRAPHQL', {
        errors: [{ message: 'Internal server error' }],
      }),
    );
    const result = await verifyRouteMapping(mapping as never);
    expect(result.state).toBe('UNAVAILABLE');
    list.mockRestore();
    byId.mockRestore();
  });

  it('standalone verification trusts a real "does not exist" text as gone', async () => {
    const assigned = await assignedNumber();
    const mapping = await getRouteForNumber(assigned.numberId);
    const pbx = mockPbx();
    const list = vi.spyOn(pbx, 'getAllInboundRoutes').mockRejectedValue(new Error('upstream 502'));
    const byId = vi.spyOn(pbx, 'getInboundRoute').mockRejectedValue(
      new FreePBXError(`Route ${mapping!.freepbx_route_id} does not exist`, 'GRAPHQL'),
    );
    const result = await verifyRouteMapping(mapping as never);
    expect(result.state).toBe('MISSING_IN_PBX');
    list.mockRestore();
    byId.mockRestore();
  });
});
