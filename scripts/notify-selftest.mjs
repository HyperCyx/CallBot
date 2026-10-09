import pg from 'pg';
const raw = process.env.DATABASE_URL ?? '';
const u = new URL(raw);
u.searchParams.delete('sslmode');
const pool = new pg.Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });

const adminTelegramId = process.argv[2];
if (!adminTelegramId) throw new Error('usage: node notify-selftest.mjs <adminTelegramId>');

const t0 = Date.now();
const ins = await pool.query(
  `INSERT INTO notifications (telegram_id, kind, payload, dedupe_key, next_run_at)
   VALUES ($1,'ADMIN_ALERT',$2::jsonb,$3,now()) RETURNING id, created_at`,
  [
    adminTelegramId,
    JSON.stringify({
      title: '🛰 Fast-path self-test',
      message: 'Notification fast path (LISTEN/NOTIFY) live check. If this arrived within a second of the enqueue, the fix works. Safe to delete.',
    }),
    `selftest:${Date.now()}`,
  ],
);
await pool.query(`SELECT pg_notify('notifications_due','')`);
const id = ins.rows[0].id;

let lagMs = null;
for (let i = 0; i < 150; i += 1) {
  const r = await pool.query(`SELECT status, sent_at FROM notifications WHERE id = $1`, [id]);
  if (r.rows[0]?.sent_at) {
    lagMs = r.rows[0].sent_at.getTime() - ins.rows[0].created_at.getTime();
    break;
  }
  await new Promise((r2) => setTimeout(r2, 100));
}
console.log(JSON.stringify({ id, lagMs, status: lagMs === null ? 'NOT DELIVERED WITHIN 15s' : 'SENT' }));
await pool.end();
