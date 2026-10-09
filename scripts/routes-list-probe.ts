import { getFreePBX } from '../src/freepbx/index.js';
const pbx = getFreePBX();
try {
  const routes = await pbx.getAllInboundRoutes();
  console.log(`allInboundRoutes OK: ${routes.length} route(s)`);
  for (const r of routes.slice(0, 15)) console.log(`  id=${r.id} ext=${r.extension} cid=${r.cidnum} dest=${JSON.stringify(r.destinationConnection)}`);
} catch (err) {
  const e = err as Error & { detail?: unknown };
  console.log('allInboundRoutes THREW:', e.message, JSON.stringify(e.detail ?? null)?.slice(0, 300));
}
process.exit(0);
