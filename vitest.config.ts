import { defineConfig } from 'vitest/config';

/**
 * Test configuration.
 *
 * Integration tests run against a REAL PostgreSQL database (not a mock) because
 * the guarantees under test - `FOR UPDATE SKIP LOCKED`, the partial unique index
 * on active assignments, the audit hash chain - only exist in the database.
 *
 *   createdb sipbot_test   (or: npm run test:db)
 *
 * `singleFork` keeps the suite serialised so concurrent-assignment tests have
 * deterministic row states between cases.
 */
export default defineConfig({
  test: {
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      LOG_PRETTY: 'false',
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://sipbot:sipbot@127.0.0.1:5432/sipbot_test',
      PGPOOL_MAX: '10',
      API_KEY: 'test-api-key-0000000000',
      SIGNING_KEY: 'test-signing-key-000000',
      TELEGRAM_BOT_TOKEN: '',
      FREEPBX_MODE: 'mock',
      AMI_ENABLED: 'false',
      SECRETS_KEK_BASE64: '',
      EXTENSION_RANGE_START: '10000',
      EXTENSION_RANGE_END: '10099',
      DEFAULT_USER_EXPIRES_DAYS: '30',
    },
    setupFiles: ['./tests/setup.ts'],
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    reporters: ['default'],
  },
});
