import { runReconciliation } from '../src/workers/reconcile.worker.js';
import { closePool } from '../src/db/pool.js';
const summary = await runReconciliation({ autoFix: true, alert: false });
console.log(JSON.stringify({ findings: summary.findings, critical: summary.critical, autoFixed: summary.autoFixed, types: [...new Set(summary.details.map((d) => `${d.severity}:${d.type}`))] }, null, 1));
await closePool();
