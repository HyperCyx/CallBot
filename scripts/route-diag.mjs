import pg from 'pg';
const raw = process.env.DATABASE_URL ?? '';
const u = new URL(raw); u.searchParams.delete('sslmode');
const pool = new pg.Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });
const maps = await pool.query(`
  SELECT id, freepbx_route_id, did_match_pattern, destination_extension, status, drift_state,
         to_char(updated_at,'MM-DD HH24:MI') AS updated
    FROM inbound_route_mappings
   WHERE deleted_at IS NULL AND status <> 'REMOVED'
   ORDER BY updated_at DESC LIMIT 12`);
console.log('mappings:', JSON.stringify(maps.rows, null, 1));
const runs = await pool.query(`
  SELECT to_char(started_at,'MM-DD HH24:MI:SS') AS started, status, left(COALESCE(error,''),110) AS error
    FROM reconciliation_runs ORDER BY started_at DESC LIMIT 6`);
console.log('runs:', JSON.stringify(runs.rows, null, 1));
await pool.end();
