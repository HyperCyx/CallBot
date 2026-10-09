/**
 * FreePBX compatibility probe (`npm run probe`).
 *
 * Read-only. It authenticates with OAuth2 (client credentials) and verifies that
 * every GraphQL operation this project uses exists on YOUR PBX, recording the
 * result in `freepbx_compat` for the admin panel.
 *
 * Run this after pointing the backend at a new PBX, and after any FreePBX
 * upgrade: operation names differ between module versions. Anything reported as
 * missing is a real blocker - the code never guesses an endpoint (spec §40).
 */
import { closePool } from '../src/db/pool.js';
import { env } from '../src/config/env.js';
import { FreePBXGraphQLClient } from '../src/freepbx/client.js';
import { runCompatibilityProbe, getStoredCompatibilityReport } from '../src/freepbx/compat.js';
import { getFreePBX, isMockMode } from '../src/freepbx/index.js';

async function main(): Promise<void> {
  if (isMockMode()) {
    // eslint-disable-next-line no-console
    console.log('FREEPBX_MODE=mock: no probe performed. Set FREEPBX_MODE=graphql and FREEPBX_* to probe a real PBX.');
    // eslint-disable-next-line no-console
    console.log(await getStoredCompatibilityReport());
    return;
  }

  // eslint-disable-next-line no-console
  console.log(`Probing ${env.freepbx.graphqlUrl || env.freepbx.baseUrl} ...`);
  const client = new FreePBXGraphQLClient();
  const ping = await client.ping();
  // eslint-disable-next-line no-console
  console.log(`Authentication: ${ping.ok ? 'OK' : `FAILED - ${ping.detail}`}`);

  const report = await runCompatibilityProbe(client);
  // eslint-disable-next-line no-console
  console.log(`\nVersions: PBX ${report.pbxVersion ?? 'unknown'}, Asterisk ${report.asteriskVersion ?? 'unknown'}, API module ${report.apiModuleVersion ?? 'unknown'}`);
  // eslint-disable-next-line no-console
  console.log(`\nRequired operations present: ${report.supported.length}`);
  if (report.notes.length > 0) {
    console.log('\nNotes:');
    for (const note of report.notes) console.log(`  • ${note}`);
  }
  const missing = report.missing;
  // eslint-disable-next-line no-console
  console.log(`\n${missing.length === 0 ? 'All required operations are available.' : `${missing.length} operation(s) missing - see docs/02-freepbx-integration.md`}\n`);
  if (missing.length > 0) process.exitCode = 2;
}

main()
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(`Probe failed: ${(err as Error).message}`);
    process.exitCode = 1;
  })
  .finally(() => closePool().catch(() => undefined));
