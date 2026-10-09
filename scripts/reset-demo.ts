/**
 * Development helper: put the live demo back into a clean, predictable state.
 *
 *   npx tsx scripts/reset-demo.ts                 # full reset
 *   npx tsx scripts/reset-demo.ts --keep-operator # leave the admin account active
 *
 * What it does
 * ------------
 * 1. removes the fixture accounts the screen walker creates (`walk_admin`,
 *    `walk_staff`, and anything else in its 555 000 xxx test range): their SIP
 *    accounts are deleted through the normal service, so the extension goes back
 *    into the pool;
 * 2. cancels their pending notifications and clears their bot sessions, so the
 *    notification worker stops retrying a chat that does not exist;
 * 3. (unless `--keep-operator`) resets the `TELEGRAM_SUPER_ADMIN_IDS` account to
 *    PENDING and frees its SIP account, so the next `/start` from that id
 *    exercises the operator bootstrap exactly as a fresh operator would see it.
 *
 * Numbers, catalogue, users' assignments and the audit log are left alone: this
 * script only cleans fixtures, never business data.
 */
import { closePool, many, query } from '../src/db/pool.js';
import { deleteSipAccount } from '../src/services/extension.service.js';
import { deleteUserAccount } from '../src/services/userDeletion.service.js';
import { env } from '../src/config/env.js';

const keepOperator = process.argv.includes('--keep-operator');
/** The range the walker uses; real Telegram ids are far larger. */
const FIXTURE_MIN = 555_000_000;
const FIXTURE_MAX = 555_999_999;

async function main(): Promise<void> {
  const fixtures = await many<{ id: string; telegram_id: number; username: string | null }>(
    `SELECT id, telegram_id, username FROM users
      WHERE telegram_id BETWEEN $1 AND $2`,
    [FIXTURE_MIN, FIXTURE_MAX],
  );

  for (const fixture of fixtures) {
    // The full production path (numbers -> routes -> extension): the old logic
    // deleted only the SIP account and relied on the PBX cascading the routes,
    // which orphaned number+mappings rows and made reconciliation scream.
    try {
      await deleteUserAccount(fixture.id, { actorId: fixture.id, reason: 'demo fixture reset' });
    } catch (err) {
      console.warn(`fixture ${fixture.username ?? fixture.telegram_id}: full deletion path failed (${(err as Error).message}); falling back`);
      await deleteSipAccount(fixture.id, { actorId: fixture.id, force: true }).catch(() => undefined);
    }
    await query("UPDATE users SET status = 'DELETED', deleted_at = now() WHERE id = $1", [fixture.id]);
    await query("UPDATE notifications SET status = 'FAILED' WHERE user_id = $1 AND status IN ('PENDING','FAILED')", [fixture.id]);
    console.log(`removed fixture account ${fixture.username ?? fixture.telegram_id}`);
  }

  // Sessions of fixture chats and the operator's next-screen stack: a reset
  // should also clear the navigation history, otherwise "⬅️ Back" walks into
  // screens that belong to a previous test run.
  await query(`DELETE FROM bot_sessions WHERE key ~ '^(555[0-9]{6}:|${env.superAdminIds.join(':|')}:)'`);

  if (!keepOperator) {
    for (const id of env.superAdminIds) {
      const row = await many<{ id: string }>('SELECT id FROM users WHERE telegram_id = $1 AND deleted_at IS NULL', [Number(id)]);
      const user = row[0];
      if (!user) continue;
      await deleteSipAccount(user.id, { actorId: user.id, force: true }).catch(() => undefined);
      await query(
        `UPDATE users
            SET status = 'PENDING', approved_at = NULL, approved_by = NULL,
                expires_at = NULL, plan_id = NULL, blocked_at = NULL, blocked_reason = NULL
          WHERE id = $1`,
        [user.id],
      );
      console.log(`operator ${id} reset to PENDING (the next /start activates it again)`);
    }
  }

  const summary = await many<{ status: string; count: string }>('SELECT status, count(*)::text AS count FROM users GROUP BY status ORDER BY status');
  console.log('users by status:', summary.map((r) => `${r.status}=${r.count}`).join(', '));
  await closePool();
}

main().catch(async (err) => {
  console.error(err);
  await closePool().catch(() => undefined);
  process.exit(1);
});
