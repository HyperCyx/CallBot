/**
 * Reconciliation runner (`npm run reconcile`, `npm run reconcile -- --dry-run`).
 *
 * Compares PostgreSQL (intended state) with FreePBX (actual state) and:
 *   * AUTO-FIXES additive, unambiguous drift (missing route, wrong destination,
 *     stale reservation, assignment stuck between PBX success and commit);
 *   * REPORTS everything else as a finding for an admin - never destructive.
 *
 * The same code runs on the reconcile interval inside the app/worker; this CLI
 * exists for cron-based deployments and for on-demand runs after an incident.
 *
 * Exit codes: 0 = clean, 1 = findings recorded, 2 = run failed.
 */
import { closePool } from '../src/db/pool.js';
import { getOpenFindings, runReconciliation } from '../src/workers/reconcile.worker.js';

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  // eslint-disable-next-line no-console
  console.log(`Reconciliation starting${dryRun ? ' (dry run: no automatic fixes)' : ''} ...`);

  const summary = await runReconciliation({ autoFix: !dryRun, alert: true });

  // eslint-disable-next-line no-console
  console.log(
    `\nRun ${summary.runId}\n  extensions on PBX: ${summary.extensionsSeen}\n  inbound routes:   ${summary.routesSeen}\n` +
      `  findings:         ${summary.findings} (${summary.critical} critical)\n  auto-fixed:       ${summary.autoFixed}\n`,
  );

  if (summary.details.length > 0) {
    // eslint-disable-next-line no-console
    console.log('Findings:');
    for (const d of summary.details) {
      // eslint-disable-next-line no-console
      console.log(`  [${d.severity}] ${d.type}: ${d.detail}`);
    }
  }

  const open = await getOpenFindings(10);
  if (open.length > 0) {
    // eslint-disable-next-line no-console
    console.log(`\n${open.length} unresolved finding(s) are waiting in the admin panel (/admin -> Reconciliation).`);
    process.exitCode = 1;
  } else {
    // eslint-disable-next-line no-console
    console.log('\nNo open findings.');
  }
}

main()
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(`Reconciliation failed: ${(err as Error).message}`);
    process.exitCode = 2;
  })
  .finally(() => closePool().catch(() => undefined));
