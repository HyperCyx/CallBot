import pg from 'pg';
const raw = process.env.DATABASE_URL ?? '';
const u = new URL(raw); u.searchParams.delete('sslmode');
const pool = new pg.Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });
const rows = await pool.query(`
  SELECT m.freepbx_route_id AS route, m.did_match_pattern AS did, m.destination_extension AS ext,
         m.status AS mapping, m.drift_state, n.status AS number_status, n.phone_number,
         COALESCE(u.telegram_id::text, '—') AS owner_tg, u.status AS user_status
    FROM inbound_route_mappings m
    LEFT JOIN numbers n ON n.id = m.number_id
    LEFT JOIN users u ON u.id = n.assigned_user_id
   WHERE m.deleted_at IS NULL AND m.status <> 'REMOVED'
   ORDER BY m.updated_at DESC`);
console.log(JSON.stringify(rows.rows, null, 1));
await pool.end();
