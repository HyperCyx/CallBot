import { afterAll, beforeAll, beforeEach } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { closePool, query } from '../src/db/pool.js';
import { setFreePBX, MockFreePBXClient } from '../src/freepbx/index.js';
import { clearSettingsCache } from '../src/services/settings.service.js';

/**
 * Test harness.
 *
 * Creates the schema in the test database (the database itself must already
 * exist - `npm run test:db` creates it), truncates the data between tests, and
 * installs a fresh mock PBX so failure injection is isolated per test.
 */

/** Tables truncated between tests, in dependency order. */
const TABLES = [
  'call_sessions',
  'wallet_transactions',
  'wallets',
  'deposit_requests',
  'payment_methods',
  'call_history',
  'cdr_sync_state',
  'referral_commissions',
  'referrals',
  'referral_codes',
  'inbound_route_mappings',
  'number_assignments',
  'numbers',
  'number_import_batches',
  'sip_accounts',
  'extension_allocations',
  'audit_logs',
  'notifications',
  'freepbx_sync_jobs',
  'reconciliation_findings',
  'reconciliation_runs',
  'pbx_inventory_snapshot',
  'bot_sessions',
  'idempotency_keys',
  'worker_heartbeats',
  'admin_settings',
  'user_roles',
  'telegram_accounts',
  'users',
  'plan_countries',
  'plan_services',
  'plans',
  'service_countries',
  'services',
  'countries',
];

let available = false;

beforeAll(async () => {
  try {
    await query('SELECT 1');
    available = true;
  } catch (err) {
    throw new Error(
      `Test database unreachable (${(err as Error).message}).\n` +
        `Create it first:\n  sudo -u postgres psql -c "CREATE USER sipbot WITH PASSWORD 'sipbot' SUPERUSER;"\n  sudo -u postgres psql -c "CREATE DATABASE sipbot_test OWNER sipbot;"`,
    );
  }
  await runMigrations();
  // Seed the baseline catalog rows that the schema does not create itself.
  await seedBaseline();
});

beforeEach(async () => {
  if (!available) return;
  setFreePBX(new MockFreePBXClient());
  clearSettingsCache();
  // audit_logs is append-only (DELETE blocked by trigger); truncate bypasses
  // triggers only if we disable them, which the test harness is allowed to do.
  await query('SET session_replication_role = replica');
  for (const table of TABLES) {
    await query(`TRUNCATE TABLE ${table} RESTART IDENTITY CASCADE`).catch(() => undefined);
  }
  await query('SET session_replication_role = origin');
  await seedBaseline();
});

afterAll(async () => {
  await closePool().catch(() => undefined);
});

/**
 * Restores the shipped configuration and system roles.
 *
 * Values live in the database (migration 012 declares them in
 * `setting_defaults`, which - like `roles` - is reference data and is never
 * truncated), never in TypeScript: the harness asks the database for the
 * defaults instead of duplicating the business configuration here.
 */
export async function seedConfiguration(): Promise<void> {
  await query('SELECT seed_admin_settings()');
  await query('SELECT seed_system_roles()');
}

/**
 * Restores the shipped state between tests: configuration (from the database's
 * own `setting_defaults` snapshot), system roles, and the minimal catalogue the
 * tests reference. Business logic is never seeded here - tests create their own
 * users, numbers and links.
 */
async function seedBaseline(): Promise<void> {
  // Configuration and roles come from the database's own seed functions.
  await seedConfiguration();

  // A minimal catalogue so tests can reference a country/service/plan. Tests
  // create their own users, numbers and links; nothing else is seeded.
  await query(
    `INSERT INTO countries (name, iso2, dial_code, flag, status, sort_order)
     VALUES ('United Arab Emirates','AE','971','🇦🇪','ACTIVE',10)
     ON CONFLICT (iso2) DO NOTHING`,
  );
  await query(
    `INSERT INTO services (slug, name, icon, status)
     VALUES ('whatsapp','WhatsApp','💬','ACTIVE')
     ON CONFLICT (slug) DO NOTHING`,
  );
  await query(
    `INSERT INTO plans (code, name, is_active, is_default, rank, max_numbers, allows_premium_numbers, price_cents_per_month, currency, duration_days)
     VALUES ('free','Free',true,true,0,1,false,0,'EUR',30),
            ('premium','Premium',true,false,10,5,true,999,'EUR',30)
     ON CONFLICT (code) DO NOTHING`,
  );
}

export async function truncateAll(): Promise<void> {
  await query('SET session_replication_role = replica');
  for (const table of TABLES) await query(`TRUNCATE TABLE ${table} RESTART IDENTITY CASCADE`).catch(() => undefined);
  await query('SET session_replication_role = origin');
  // TRUNCATE ... CASCADE on `users` also empties admin_settings (FK updated_by),
  // so configuration is restored together with the catalogue.
  await seedBaseline();
}
