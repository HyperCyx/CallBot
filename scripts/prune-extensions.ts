/**
 * Prunes SIP extensions that this platform allocated to users that no longer
 * exist.
 *
 * How an extension ends up orphaned:
 *   * an interrupted delete (the user row went, the PBX call never ran),
 *   * a crashed process between the DB write and the PBX call,
 *   * an older build whose API delete path forgot the SIP account.
 *
 * Only extensions recorded in `sip_accounts` are considered, and only when the
 * owner is gone (soft-deleted or missing). An extension the platform never
 * allocated - an operator's hand-made FreePBX extension, say - is never touched:
 * it is not ours to delete.
 *
 * Usage:
 *   npx tsx scripts/prune-extensions.ts            # report only (default)
 *   npx tsx scripts/prune-extensions.ts --apply    # delete on the PBX + close DB rows
 */
import { getFreePBX } from '../src/freepbx/index.js';
import { FreePBXError } from '../src/freepbx/types.js';
import { closePool, query, many } from '../src/db/pool.js';
import { writeAudit } from '../src/services/audit.service.js';
import { logger } from '../src/lib/logger.js';

interface Orphan {
  id: string;
  extension: string;
  status: string;
  user_id: string | null;
  user_status: string | null;
}

const apply = process.argv.includes('--apply');

async function main(): Promise<void> {
  const orphans = await many<Orphan>(
    `SELECT sa.id, sa.extension, sa.status, sa.user_id, u.status AS user_status
       FROM sip_accounts sa
       LEFT JOIN users u ON u.id = sa.user_id
      WHERE sa.deleted_at IS NULL
        AND (u.id IS NULL OR u.status = 'DELETED')
      ORDER BY sa.extension`,
  );

  if (orphans.length === 0) {
    console.log('Nothing to prune: every live SIP extension belongs to a live user.');
    return;
  }

  console.log(`Orphaned SIP extensions (owner deleted or missing): ${orphans.length}`);
  for (const o of orphans) {
    console.log(`  ${o.extension} — account ${o.status}, owner ${o.user_status ?? 'MISSING'}${o.user_id ? '' : ' (no user row)'}`);
  }

  if (!apply) {
    console.log('\nReport only. Re-run with --apply to delete these extensions on the PBX and close their DB rows.');
    return;
  }

  const pbx = getFreePBX();
  let deleted = 0;
  for (const o of orphans) {
    try {
      await pbx.deleteExtension(o.extension);
    } catch (err) {
      // A missing extension is a success for a delete (idempotent).
      if (!(err instanceof FreePBXError) || err.kind !== 'NOT_FOUND') {
        logger.error({ extension: o.extension, err: (err as Error).message }, 'could not delete orphaned extension on the PBX; left as is');
        continue;
      }
    }

    await query("UPDATE sip_accounts SET status = 'DELETED', deleted_at = now() WHERE id = $1", [o.id]);
    await query(
      'UPDATE extension_allocations SET released_at = now(), reason = $2 WHERE extension = $1 AND released_at IS NULL',
      [o.extension, 'pruned: owner no longer exists'],
    );
    await writeAudit({
      actorType: 'SYSTEM',
      action: 'SIP_ACCOUNT_DELETED',
      targetType: 'sip_account',
      targetId: o.id,
      targetRef: o.extension,
      reason: 'pruned: owner no longer exists',
    });
    deleted += 1;
    console.log(`  ✓ removed ${o.extension}`);
  }

  console.log(`\nPruned ${deleted} of ${orphans.length} orphaned extension(s).`);
}

main()
  .catch((err) => {
    console.error('Prune failed:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closePool());
