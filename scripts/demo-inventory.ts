/**
 * Development helper: fill the inventory so the bot can be tested end to end.
 *
 * `npx tsx scripts/demo-inventory.ts [countPerOffer]`
 *
 * For every ACTIVE country/service offer it imports `countPerOffer` DIDs whose
 * numbers match the country's dial code (the import validates that), half of
 * them marked PREMIUM when the offer allows it. Numbers are random and complete
 * E.164 numbers in the operator's own test ranges — this is demo data for a
 * development database, never for production.
 *
 * Safe to re-run: duplicates are reported and skipped, not duplicated.
 */
import { closePool, many } from '../src/db/pool.js';
import { importNumbers } from '../src/services/inventory.service.js';
import { logger } from '../src/lib/logger.js';

const count = Number(process.argv[2] ?? 4);

/** National-number blocks that look plausible per dial code (demo data only). */
const NATIONAL_BLOCKS: Record<string, string> = {
  '1': '2025550',     // US/CA
  '31': '612345',     // NL
  '44': '7400123',    // GB
  '49': '1511234',    // DE
  '91': '987650',     // IN
  '971': '5012345',   // AE
};

function fakeDid(dialCode: string, seq: number): string {
  const block = NATIONAL_BLOCKS[dialCode] ?? `${dialCode}5`;
  const tail = String(seq).padStart(3, '0');
  return `+${dialCode}${block}${tail}`;
}

async function main(): Promise<void> {
  const offers = await many<{
    country_id: string;
    service_id: string;
    country: string;
    service: string;
    dial_code: string;
    requires_premium: boolean;
  }>(
    `SELECT sc.country_id, sc.service_id, c.name AS country, c.dial_code, s.name AS service,
            sc.requires_premium
       FROM service_countries sc
       JOIN countries c ON c.id = sc.country_id AND c.status = 'ACTIVE'
       JOIN services  s ON s.id = sc.service_id AND s.status = 'ACTIVE'
      WHERE sc.status = 'ACTIVE'
      ORDER BY c.sort_order, s.sort_order`,
  );

  if (offers.length === 0) {
    // eslint-disable-next-line no-console
    console.log('No active country/service offers. Run `npm run seed` first.');
    return;
  }

  // A shared admin to attribute the import to (any real user row works).
  const actor = await many<{ id: string }>('SELECT id FROM users ORDER BY created_at LIMIT 1');
  const actorId = actor[0]?.id;
  if (!actorId) {
    // eslint-disable-next-line no-console
    console.log('No user exists yet to attribute the import to. Start the bot with /start once, then re-run this script.');
    return;
  }

  let seq = 10;
  let totalImported = 0;

  for (const offer of offers) {
    const numbers: string[] = [];
    for (let i = 0; i < count; i += 1) numbers.push(fakeDid(offer.dial_code, seq++));

    const half = Math.ceil(numbers.length / 2);
    const result = await importNumbers({
      countryId: offer.country_id,
      serviceId: offer.service_id,
      planType: offer.requires_premium ? 'PREMIUM' : 'FREE',
      numbers: numbers.slice(0, half),
      actorId,
      source: 'BULK',
    });
    const premium = await importNumbers({
      countryId: offer.country_id,
      serviceId: offer.service_id,
      planType: 'PREMIUM',
      numbers: numbers.slice(half),
      actorId,
      source: 'BULK',
    });

    const imported = result.imported + premium.imported;
    totalImported += imported;
    logger.info(
      { country: offer.country, service: offer.service, imported, duplicates: result.duplicates + premium.duplicates },
      'offer stocked',
    );
  }

  // eslint-disable-next-line no-console
  console.log(`\nImported ${totalImported} demo numbers across ${offers.length} country/service offers.`);
  // eslint-disable-next-line no-console
  console.log('They are random E.164 numbers in ranges reserved for examples/testing - replace them with real DIDs before any real use.\n');
}

main()
  .catch((err) => {
    logger.error({ err: (err as Error).message }, 'demo inventory failed');
    process.exitCode = 1;
  })
  .finally(() => closePool().catch(() => undefined));
