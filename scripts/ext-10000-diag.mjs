import pg from 'pg';
const raw = process.env.DATABASE_URL ?? '';
const u = new URL(raw); u.searchParams.delete('sslmode');
const pool = new pg.Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });
const acct = await pool.query(`SELECT id, extension, user_id, status, to_char(updated_at,'MM-DD HH24:MI:SS') AS updated FROM sip_accounts WHERE extension = '10000'`);
console.log('sip_account 10000:', JSON.stringify(acct.rows));
if (acct.rows[0]) {
  const usr = await pool.query(`SELECT id, telegram_id, username, display_name, status FROM users WHERE id = $1`, [acct.rows[0].user_id]);
  console.log('owner user:', JSON.stringify(usr.rows));
  const audits = await pool.query(
    `SELECT to_char(created_at,'HH24:MI:SS') AS at, action, actor_type, left(COALESCE(actor_id::text,''),36) AS actor, metadata::text AS meta
       FROM audit_logs
      WHERE (target_id = $1 OR target_ref LIKE '%10000%' OR (metadata::text ILIKE '%10000%'))
        AND created_at > '2026-10-08 04:30'::timestamptz
      ORDER BY created_at DESC LIMIT 12`,
    [acct.rows[0].id],
  );
  console.log('audit:', JSON.stringify(audits.rows, null, 1));
}
await pool.end();
