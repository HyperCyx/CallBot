/**
 * Deployment seed script (`npm run seed`).
 *
 * Everything here is DATA, not business logic: the platform reads countries,
 * services, plans and settings from PostgreSQL at runtime, so a fresh
 * deployment needs a starting catalogue. Every row remains editable from the
 * Telegram admin panel afterwards (spec §22, §45).
 *
 * Idempotent by design: running it twice changes nothing. Existing values are
 * never overwritten, so it is safe in a deploy pipeline.
 *
 * Usage:
 *   npm run seed                 # settings + roles + starter catalogue (only if empty)
 *   npm run seed -- --force-catalogue   # add the starter catalogue even if rows exist
 */
import { runMigrations } from '../src/db/migrate.js';
import { closePool, one, query } from '../src/db/pool.js';
import { logger } from '../src/lib/logger.js';

/**
 * Starter catalogue. Explicitly a convenience default, NOT a hard-coded
 * business rule: the platform works with any country/service an operator adds.
 * Dial codes come from the public E.164 assignments and are stored in the
 * countries table, which the bot reads.
 */
const COUNTRIES: Array<{ name: string; iso2: string; iso3: string; dialCode: string; flag: string; sort: number }> = [
  { name: 'United Arab Emirates', iso2: 'AE', iso3: 'ARE', dialCode: '971', flag: '🇦🇪', sort: 10 },
  { name: 'United States', iso2: 'US', iso3: 'USA', dialCode: '1', flag: '🇺🇸', sort: 20 },
  { name: 'United Kingdom', iso2: 'GB', iso3: 'GBR', dialCode: '44', flag: '🇬🇧', sort: 30 },
  { name: 'India', iso2: 'IN', iso3: 'IND', dialCode: '91', flag: '🇮🇳', sort: 40 },
  { name: 'Germany', iso2: 'DE', iso3: 'DEU', dialCode: '49', flag: '🇩🇪', sort: 50 },
  { name: 'Netherlands', iso2: 'NL', iso3: 'NLD', dialCode: '31', flag: '🇳🇱', sort: 60 },
  { name: 'Canada', iso2: 'CA', iso3: 'CAN', dialCode: '1', flag: '🇨🇦', sort: 70 },
];

const SERVICES: Array<{ slug: string; name: string; icon: string; description: string; sort: number }> = [
  { slug: 'whatsapp', name: 'WhatsApp', icon: '💬', description: 'Number used to receive WhatsApp verification messages.', sort: 10 },
  { slug: 'telegram', name: 'Telegram', icon: '✈️', description: 'Number used for Telegram account verification.', sort: 20 },
  { slug: 'signal', name: 'Signal', icon: '🔒', description: 'Number used for Signal registration.', sort: 30 },
  { slug: 'calls', name: 'Calls / SMS', icon: '📞', description: 'Generic inbound calls and SMS.', sort: 40 },
];

async function seedSettingsAndRoles(): Promise<void> {
  const settings = await one<{ count: string }>('SELECT seed_admin_settings() AS count');
  const roles = await one<{ count: string }>('SELECT seed_system_roles() AS count');
  logger.info({ settingsRestored: Number(settings?.count ?? 0), rolesInserted: Number(roles?.count ?? 0) }, 'settings + roles seeded');
}

async function seedCatalogue(force: boolean): Promise<void> {
  const existingCountries = await one<{ count: string }>('SELECT count(*)::text AS count FROM countries');
  const existingServices = await one<{ count: string }>('SELECT count(*)::text AS count FROM services');
  const countryCount = Number(existingCountries?.count ?? 0);
  const serviceCount = Number(existingServices?.count ?? 0);

  if ((countryCount > 0 || serviceCount > 0) && !force) {
    logger.info({ countries: countryCount, services: serviceCount }, 'catalogue already populated - skipped (use --force-catalogue to add the starter list anyway)');
  } else {
    for (const c of COUNTRIES) {
      await query(
        `INSERT INTO countries (name, iso2, iso3, dial_code, flag, status, sort_order)
         VALUES ($1,$2,$3,$4,$5,'ACTIVE',$6)
         ON CONFLICT (iso2) DO NOTHING`,
        [c.name, c.iso2, c.iso3, c.dialCode, c.flag, c.sort],
      );
    }
    for (const s of SERVICES) {
      await query(
        `INSERT INTO services (slug, name, icon, description, status, sort_order)
         VALUES ($1,$2,$3,$4,'ACTIVE',$5)
         ON CONFLICT (slug) DO NOTHING`,
        [s.slug, s.name, s.icon, s.description, s.sort],
      );
    }
    logger.info({ countries: COUNTRIES.length, services: SERVICES.length }, 'starter catalogue ensured');
  }

  // Service/country availability is explicit: nothing is offered unless an
  // operator enables it. This inserts the full matrix for the starter catalogue
  // only - afterwards the admin panel owns it.
  const inserted = await query(
    `INSERT INTO service_countries (service_id, country_id, status)
     SELECT s.id, c.id, 'ACTIVE'
       FROM services s CROSS JOIN countries c
      WHERE s.status = 'ACTIVE' AND c.status = 'ACTIVE'
     ON CONFLICT (service_id, country_id) DO NOTHING`,
  );
  logger.info({ serviceCountryLinks: inserted.rowCount ?? 0 }, 'service/country availability ensured');
}

async function main(): Promise<void> {
  const force = process.argv.includes('--force-catalogue');

  logger.info('running migrations before seeding');
  const migrationResult = await runMigrations();
  logger.info({ applied: migrationResult.applied.length, skipped: migrationResult.skipped }, 'migrations complete');

  await seedSettingsAndRoles();
  await seedCatalogue(force);

  const summary = await one<{ countries: string; services: string; plans: string; settings: string; roles: string }>(`
    SELECT (SELECT count(*)::text FROM countries) AS countries,
           (SELECT count(*)::text FROM services)  AS services,
           (SELECT count(*)::text FROM plans)     AS plans,
           (SELECT count(*)::text FROM admin_settings) AS settings,
           (SELECT count(*)::text FROM roles)     AS roles
  `);
  // eslint-disable-next-line no-console
  console.log(`\nSeed complete.\n  countries: ${summary?.countries}\n  services:  ${summary?.services}\n  plans:     ${summary?.plans}\n  settings:  ${summary?.settings}\n  roles:     ${summary?.roles}\n`);
  // eslint-disable-next-line no-console
  console.log('Next: create the first admin (ADMIN_TELEGRAM_IDS in .env or a role row), then start the bot.');
}

main()
  .catch((err) => {
    logger.error({ err: (err as Error).message }, 'seed failed');
    process.exitCode = 1;
  })
  .finally(() => closePool().catch(() => undefined));
