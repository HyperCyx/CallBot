import pg from 'pg';
const raw = process.env.DATABASE_URL ?? '';
const u = new URL(raw);
u.searchParams.delete('sslmode');
const pool = new pg.Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });
const recent = await pool.query(`
  SELECT id, kind, telegram_id, status, attempts, max_attempts,
         to_char(created_at,'HH24:MI:SS') AS created,
         to_char(next_run_at,'HH24:MI:SS') AS next_run,
         to_char(sent_at,'HH24:MI:SS') AS sent,
         EXTRACT(EPOCH FROM (sent_at - created_at))::int AS lag_s,
         left(COALESCE(last_error,''),140) AS err
    FROM notifications
   WHERE created_at > now() - interval '12 hours'
   ORDER BY created_at DESC LIMIT 25`);
console.log(JSON.stringify(recent.rows, null, 1));
const open = await pool.query(`
  SELECT kind, status, count(*)::int, min(created_at)::text AS oldest
    FROM notifications WHERE status IN ('PENDING','FAILED') GROUP BY 1,2 ORDER BY 1,2`);
console.log('open:', JSON.stringify(open.rows, null, 1));
await pool.end();
