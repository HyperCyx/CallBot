import pg from 'pg';
const u = new URL(process.env.DATABASE_URL); u.searchParams.delete('sslmode');
const pool = new pg.Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });
const rows = await pool.query(
  `SELECT id, telegram_id, username, display_name, status FROM users
    WHERE id IN ('7d1116d2-64ab-4d31-bacf-0af4cf12ef68','ffc70dbd-da1f-4eed-a741-a0a0e7a9045d')`,
);
console.log(JSON.stringify(rows.rows, null, 1));
await pool.end();
