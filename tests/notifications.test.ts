import { describe, expect, it } from 'vitest';
import { many, one, query } from '../src/db/pool.js';
import { enqueueAdminNotification } from '../src/services/notification.service.js';
import { createUser } from './helpers.js';

/**
 * Admin notification targeting (operator complaints 2026-10-09):
 *  - a registration must ALWAYS page every ACTIVE admin/super_admin,
 *  - DELETED/blocked admins must NOT be paged (two such legacy rows existed
 *    live and proved the filter matters),
 *  - approval/rejection must enqueue one row per admin with a per-decision
 *    dedupe key (restarts must never re-spam the room).
 *
 * The env superAdminIds fallback is covered by the vitest env having no such
 * list: with no role-holders in the DB there must be zero rows.
 */

async function grantRole(userId: string, role: 'admin' | 'super_admin'): Promise<void> {
  await query(
    `INSERT INTO user_roles (user_id, role_id, granted_at)
       SELECT $1, id, now() FROM roles WHERE code = $2
     ON CONFLICT DO NOTHING`,
    [userId, role],
  );
}

describe('enqueueAdminNotification targeting', () => {
  it('pages every ACTIVE admin+super_admin, never DELETED/blocked, never a plain user', async () => {
    const active = await createUser({ telegramId: 930_100_001, username: 'liveadmin' });
    const superA = await createUser({ telegramId: 930_200_002, username: 'livesuper' });
    const deleted = await createUser({ telegramId: 930_300_003, username: 'deadadmin', status: 'ACTIVE' });
    const blocked = await createUser({ telegramId: 930_400_004, username: 'blockedadmin', status: 'BLOCKED' });
    const plainUser = await createUser({ telegramId: 930_500_005, username: 'plainuser' });
    await grantRole(active.id, 'admin');
    await grantRole(superA.id, 'super_admin');
    await grantRole(deleted.id, 'admin');
    await grantRole(blocked.id, 'admin');
    // plainUser deliberately gets NO role — he must never be paged.
    await query("UPDATE users SET status='DELETED', deleted_at=now() WHERE id=$1", [deleted.id]);

    await enqueueAdminNotification('ADMIN_ALERT', { title: 'T', message: 'M' }, 'uact:test:case1');

    const rows = await many<{ telegram_id: number; dedupe_key: string }>(
      "SELECT telegram_id, dedupe_key FROM notifications WHERE kind='ADMIN_ALERT' AND dedupe_key LIKE 'uact:test:case1:%' ORDER BY telegram_id",
    );
    const tgs = rows.map((r) => Number(r.telegram_id)).sort();
    // role holders ACTIVE: active + superA; plus the .env superAdminIds fallback
    // (dotenv loads the real .env: 1211362365 - the operator). The three bad
    // apples (DELETED admin 930300003, BLOCKED admin 930400004, plain user
    // 930500005) get nothing.
    for (const good of [active.telegram_id, superA.telegram_id, 1211362365]) expect(tgs).toContain(good);
    for (const bad of [deleted.telegram_id, blocked.telegram_id, plainUser.telegram_id]) expect(tgs).not.toContain(bad);
    // dedupe keys are suffixed per target, so a restart can never double-send.
    expect(rows.every((r) => r.dedupe_key === `uact:test:case1:${r.telegram_id}`)).toBe(true);
    // exactly one row per target (no duplicated pages for the same decision).
    expect(new Set(tgs).size).toBe(tgs.length);
  });

  it('same dedupe key enqueued twice keeps exactly one row per admin', async () => {
    const admin = await createUser({ telegramId: 930_600_006, username: 'dupadmin' });
    await grantRole(admin.id, 'admin');
    await enqueueAdminNotification('ADMIN_ALERT', { title: 'T', message: 'M' }, 'uact:test:once');
    await enqueueAdminNotification('ADMIN_ALERT', { title: 'T', message: 'M' }, 'uact:test:once');
    const row = await one<{ c: string }>(
      'SELECT count(*)::text AS c FROM notifications WHERE dedupe_key = $1',
      [`uact:test:once:${admin.telegram_id}`],
    );
    expect(Number(row!.c)).toBe(1);
  });

  it('env fallback still pages the operator even with zero role holders in the DB', async () => {
    // Fresh deployment guard rail: no roles granted yet, nobody crashes, the
    // .env superAdminIds target (1211362365) still receives the page.
    await enqueueAdminNotification('ADMIN_ALERT', { title: 'T', message: 'M' }, 'uact:test:fresh');
    const rows = await many<{ telegram_id: number }>(
      "SELECT telegram_id FROM notifications WHERE dedupe_key LIKE 'uact:test:fresh:%'",
    );
    expect(rows.map((r) => Number(r.telegram_id))).toEqual([1211362365]);
  });
});
