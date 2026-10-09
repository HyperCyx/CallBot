import { getFreePBX } from '../src/freepbx/index.js';

const pbx = getFreePBX();
const ids = process.argv.slice(2);
if (ids.length === 0) {
  console.error('usage: route-live-probe <routeId> [...]');
  process.exit(1);
}
for (const id of ids) {
  try {
    const route = await pbx.getInboundRoute(id);
    console.log(`${id} ->`, route ? `EXISTS dest=${JSON.stringify(route.destinationConnection)}` : 'null (not found, no error)');
  } catch (err) {
    const e = err as Error & { kind?: string; detail?: unknown };
    console.log(`${id} -> THREW kind=${e.kind ?? '?'} msg=${e.message}`);
    console.log('   detail:', JSON.stringify(e.detail ?? null)?.slice(0, 500));
  }
}
process.exit(0);
