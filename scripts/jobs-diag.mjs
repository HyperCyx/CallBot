import pg from 'pg';
const raw = process.env.DATABASE_URL ?? '';
const u = new URL(raw); u.searchParams.delete('sslmode');
const pool = new pg.Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });
const jobs = await pool.query(`
  SELECT job_type, status, attempts, left(COALESCE(last_error,''),100) AS err,
         to_char(created_at,'MM-DD HH24:MI:SS') AS created
    FROM freepbx_sync_jobs
   WHERE created_at > now() - interval '12 hours'
   ORDER BY created_at DESC LIMIT 12`);
console.log(JSON.stringify(jobs.rows, null, 1));
await pool.end();
