/**
 * Read-only inspection of a real FreePBX.
 *
 *   npx tsx scripts/inspect-pbx.ts
 *
 * Answers the questions that must be settled before the platform is allowed to
 * write to somebody's PBX:
 *
 *   1. what extensions already exist (so `EXTENSION_RANGE_*` cannot collide with
 *      them, and so the allocator's pool is not silently wrong);
 *   2. what inbound routes already exist (so reconciliation can tell "ours" from
 *      "the operator's own");
 *   3. which of those extensions belong to us (a SIP account row) and which do
 *      not - the first reconciliation run will report the difference.
 *
 * Nothing here mutates the PBX: it only queries.
 */
import { FreePBXGraphQLClient } from '../src/freepbx/client.js';
import { closePool, many } from '../src/db/pool.js';
import { env } from '../src/config/env.js';

async function main(): Promise<void> {
  const client = new FreePBXGraphQLClient();

  const ping = await client.ping();
  console.log(`GraphQL: ${ping.ok ? 'reachable' : `NO (${ping.detail})`}`);
  if (!ping.ok) return;

  // --- extensions ---------------------------------------------------------
  const extensions = await client.getAllExtensions().catch((err: Error) => {
    console.log(`listExtensions failed: ${err.message}`);
    return [];
  });
  console.log(`\nExtensions on the PBX: ${extensions.length}`);
  for (const ext of extensions.slice(0, 50)) {
    const name = ext.user?.name ?? '';
    const tech = ext.coreDevice?.tech ?? ext.coreDevice?.sipdriver ?? '';
    console.log(`  ${ext.extensionId}${name ? ` ${name}` : ''}${tech ? ` (${tech})` : ''}`);
  }
  if (extensions.length > 50) console.log(`  … and ${extensions.length - 50} more`);

  // --- inbound routes -----------------------------------------------------
  const routes = await client.getAllInboundRoutes().catch((err: Error) => {
    console.log(`listInboundRoutes failed: ${err.message}`);
    return [];
  });
  console.log(`\nInbound routes on the PBX: ${routes.length}`);
  for (const route of routes.slice(0, 50)) {
    const target = ('destination' in route && route.destination) || ('destinationConnection' in route && route.destinationConnection) || '';
    console.log(`  ${route.id} → cidnum=${route.cidnum ?? '(any)'} ${target ? `→ ${target}` : ''}`);
  }

  // --- our side of the story ---------------------------------------------
  const ourExtensions = await many<{ extension: string; status: string }>(
    'SELECT extension, status FROM sip_accounts WHERE deleted_at IS NULL ORDER BY extension',
  );
  console.log(`\nExtensions in our database: ${ourExtensions.length}${ourExtensions.length ? ` (${ourExtensions.map((e) => e.extension).join(', ')})` : ''}`);

  const pbxIds = new Set(extensions.map((e) => String(e.extensionId)));
  const ours = new Set(ourExtensions.map((e) => e.extension));
  const unmanaged = extensions.filter((e) => !ours.has(String(e.extensionId))).map((e) => String(e.extensionId));
  const missingOnPbx = ourExtensions.filter((e) => !pbxIds.has(e.extension)).map((e) => e.extension);

  console.log(`\nNot managed by this platform (${unmanaged.length}): ${unmanaged.slice(0, 30).join(', ') || '—'}`);
  console.log(`In our DB but not on the PBX (${missingOnPbx.length}): ${missingOnPbx.join(', ') || '—'}`);

  // --- extension range sanity --------------------------------------------
  const { start, end } = env.freepbx.extensionRange;
  const inRange = extensions
    .map((e) => Number(e.extensionId))
    .filter((n) => Number.isFinite(n) && n >= start && n <= end)
    .sort((a, b) => a - b);
  console.log(`\nConfigured EXTENSION_RANGE: ${start}-${end}`);
  if (inRange.length === 0) {
    console.log('  ✅ no existing PBX extension falls in that range: the allocator cannot collide with them');
  } else {
    console.log(
      `  ⚠️  ${inRange.length} existing extension(s) inside the range: ${inRange.slice(0, 30).join(', ')}. ` +
        `These belong to you, not to the platform: the allocator probes the PBX first and skips any number it ` +
        `already owns, so no collision is possible.`,
    );
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => closePool().catch(() => undefined));
