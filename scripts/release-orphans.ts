/**
 * One-off repair (2026-10-08): numbers left ASSIGNED to users whose accounts
 * were deleted out-of-band (fixture resets before the deletion-service fix).
 * Releases them back to inventory through the normal service so route removal,
 * mapping cleanup and audit all happen exactly as in production.
 */
import { closePool, many, oneOrThrow } from '../src/db/pool.js';
import { releaseNumber } from '../src/services/assignment.service.js';
import { env } from '../src/config/env.js';

const orphans = await many<{ id: string; phone_number: string; owner: string }>(
  `SELECT n.id, n.phone_number, u.telegram_id AS owner
     FROM numbers n
     JOIN users u ON u.id = n.assigned_user_id
    WHERE n.status = 'ASSIGNED' AND n.deleted_at IS NULL AND u.status = 'DELETED'`,
);

console.log(`found ${orphans.length} orphaned assignment(s)`);
const operator = await oneOrThrow<{ id: string }>(
  'SELECT id FROM users WHERE telegram_id = $1',
  [Number(env.superAdminIds[0])],
  'operator account',
);
for (const orphan of orphans) {
  await releaseNumber(orphan.id, {
    actorId: operator.id,
    actorTelegramId: Number(env.superAdminIds[0]),
    actorType: 'ADMIN',
    reason: 'owner account deleted out-of-band; releasing orphaned assignment',
  });
  console.log(`released ${orphan.phone_number} (was held by deleted user ${orphan.owner})`);
}

const after = await many<{ status: string; count: string }>(
  `SELECT n.status, count(*)::text AS count
     FROM numbers n JOIN users u ON u.id = n.assigned_user_id
    WHERE n.deleted_at IS NULL AND u.status = 'DELETED' GROUP BY n.status`,
);
console.log('remaining rows owned by deleted users:', JSON.stringify(after));
await closePool();
