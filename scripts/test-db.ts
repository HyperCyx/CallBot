/**
 * Creates the test database if it does not exist (`npm run test:db`).
 *
 * Kept in version control because the integration suite needs a real PostgreSQL
 * instance: row locks, partial unique indexes and triggers are the guarantees
 * under test, and they cannot be faked in memory.
 *
 * Connects to the `postgres` maintenance database using the same credentials as
 * DATABASE_URL, so it works with a local install, a Docker compose stack, or CI.
 */
import { Client } from 'pg';
import { sslFromConnectionString } from '../src/db/pool.js';

const TEST_DB = process.env.TEST_DB_NAME ?? 'sipbot_test';
const MAINTENANCE_DB = process.env.MAINTENANCE_DB ?? 'postgres';

function targetFromEnv(): { adminUrl: string; testUrl: string } {
  const raw = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!raw) throw new Error('Set DATABASE_URL (or TEST_DATABASE_URL) before running this script.');

  const url = new URL(raw);
  url.pathname = `/${MAINTENANCE_DB}`;
  const adminUrl = url.toString();

  const test = new URL(raw);
  test.pathname = `/${TEST_DB}`;
  return { adminUrl, testUrl: test.toString() };
}

async function main(): Promise<void> {
  const { adminUrl, testUrl } = targetFromEnv();
  const target = sslFromConnectionString(adminUrl);
  const client = new Client({ connectionString: target.connectionString, ...(target.ssl ? { ssl: target.ssl } : {}) });
  await client.connect();
  try {
    const exists = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [TEST_DB]);
    if (exists.rowCount) {
      // eslint-disable-next-line no-console
      console.log(`Test database "${TEST_DB}" already exists - nothing to do.`);
      return;
    }
    // Identifiers cannot be parameterised; the name is a local constant, never
    // user input, and is quoted defensively.
    await client.query(`CREATE DATABASE "${TEST_DB.replace(/"/g, '""')}"`);
    // eslint-disable-next-line no-console
    console.log(`Created test database "${TEST_DB}".`);
  } finally {
    await client.end();
  }
  // eslint-disable-next-line no-console
  console.log(`Tests will connect to: ${testUrl.replace(/:[^:@/]*@/, ':****@')}`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(
    `\nCould not create the test database: ${(err as Error).message}\n\n` +
      `Create it manually instead:\n` +
      `  sudo -u postgres psql -c "CREATE USER sipbot WITH PASSWORD 'sipbot' SUPERUSER;"\n` +
      `  sudo -u postgres psql -c "CREATE DATABASE ${TEST_DB} OWNER sipbot;"\n\n` +
      `Then set TEST_DATABASE_URL if it differs from DATABASE_URL.\n`,
  );
  process.exitCode = 1;
});
