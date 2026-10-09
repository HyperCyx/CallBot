import { runMigrations } from '../src/db/migrate.js';
import { closePool } from '../src/db/pool.js';
import { logger } from '../src/lib/logger.js';

const { applied, skipped } = await runMigrations();
logger.info(
  { applied: applied.length, skipped: skipped.length },
  applied.length > 0 ? `Applied ${applied.length} migration(s)` : 'Database is up to date',
);
await closePool();
