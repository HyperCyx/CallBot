import pg from 'pg';
const raw = process.env.DATABASE_URL ?? '';
const u = new URL(raw); u.searchParams.delete('sslmode');
const pool = new pg.Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });
const events = await pool.query(`
  SELECT to_char(created_at,'HH24:MI:SS') AS at, action, actor_type,
         left(COALESCE(target_type,''),20) AS ttype, left(COALESCE(target_id::text,''),36) AS target
    FROM audit_logs
   WHERE created_at > now() - interval '5 hours'
     AND (action ILIKE '%PASSWORD%' OR action ILIKE '%ROTAT%' OR action ILIKE '%DELETE%' OR action ILIKE '%SIP%')
   ORDER BY created_at DESC LIMIT 15`);
console.log(JSON.stringify(events.rows, null, 1));
const acct = await pool.query(`
  SELECT extension, status, to_char(updated_at,'YYYY-MM-DD HH24:MI:SS') AS updated
    FROM sip_accounts ORDER BY created_at LIMIT 8`);
console.log('accounts:', JSON.stringify(acct.rows));
await pool.end();
