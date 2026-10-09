import { LOCK_KEYS, many, one, query, withAdvisoryLock, withTransaction } from '../db/pool.js';
import { env } from '../config/env.js';
import { AppError, conflict, notFound } from '../lib/errors.js';
import { decryptSecret, encryptSecret, generateSipPassword } from '../lib/crypto.js';
import { logger } from '../lib/logger.js';
import { getFreePBX } from '../freepbx/index.js';
import { FreePBXError } from '../freepbx/types.js';
import { writeAudit } from './audit.service.js';
import { enqueueJob } from './pbxJob.service.js';

/**
 * SIP account + extension provisioning (spec §5, §18).
 *
 * Extension allocation is the step that must not race: two simultaneous
 * approvals must never produce two users on extension 10194. The allocator
 * takes a transaction-scoped advisory lock, so the "find the lowest free
 * extension" decision is serialised, and `sip_accounts.extension` is UNIQUE as
 * a second line of defence.
 *
 * A PBX failure does NOT leave a half-provisioned user: the allocation is
 * released and the error surfaces to the admin, who can retry.
 */

export interface SipAccountRow {
  id: string;
  user_id: string;
  extension: string;
  technology: 'pjsip' | 'sip';
  sip_server: string | null;
  sip_port: number | null;
  sip_transport: string | null;
  sip_domain: string | null;
  display_name: string | null;
  caller_id: string | null;
  outbound_cid: string | null;
  status: 'PROVISIONING' | 'ACTIVE' | 'SUSPENDED' | 'DELETED' | 'ERROR';
  freepbx_id: string | null;
  created_at: Date;
  last_sync_at: Date | null;
  last_sync_error: string | null;
}

export interface SipCredentials {
  extension: string;
  password: string;
  server: string;
  port: number;
  transport: string;
  domain: string;
}

/** Public SIP endpoint shown to users. Comes from configuration, never hard-coded. */
export function sipEndpointConfig(): { server: string; port: number; transport: string; domain: string } {
  const host = env.SIP_HOST ?? (env.freepbx.baseUrl ? new URL(env.freepbx.baseUrl).hostname : 'pbx.example.com');
  return {
    server: host,
    port: env.SIP_PORT,
    transport: 'UDP',
    domain: host,
  };
}

/**
 * Finds the lowest free extension inside the configured range.
 * Must be called inside a transaction that holds LOCK_KEYS.EXTENSION_POOL.
 */
async function findFreeExtension(
  client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> },
  skip: ReadonlySet<string> = new Set(),
): Promise<string> {
  const { start, end } = env.freepbx.extensionRange;
  const taken = await client.query(
    `SELECT extension FROM sip_accounts WHERE deleted_at IS NULL
     UNION
     SELECT extension FROM extension_allocations WHERE released_at IS NULL`,
  );
  const takenSet = new Set((taken.rows as { extension: string }[]).map((r) => r.extension));

  for (let candidate = start; candidate <= end; candidate += 1) {
    const ext = String(candidate);
    if (!takenSet.has(ext) && !skip.has(ext)) return ext;
  }
  throw new AppError('NO_INVENTORY', 'No free SIP extensions remain in the configured range. Widen EXTENSION_RANGE_* or remove unused accounts.');
}

export interface ProvisionResult {
  account: SipAccountRow;
  credentials: SipCredentials;
  pbxWarning?: string;
}

/**
 * Creates the SIP account for an approved user.
 *
 * @param opts.sipPassword optionally force a password (tests / admin override)
 * @param opts.retry        true when re-running after a previous PBX failure
 */
/**
 * True when this extension already exists on the PBX.
 *
 * The number range is shared with everything an operator created by hand in the
 * FreePBX GUI, and a half-finished job can leave an extension behind. Our
 * database only knows about extensions this platform allocated, so the PBX has
 * to be asked directly - it is the authority on what is free.
 */
async function pbxHasExtension(pbx: { getExtension: (id: string) => Promise<unknown> }, extension: string): Promise<boolean> {
  try {
    return Boolean(await pbx.getExtension(extension));
  } catch (err) {
    // A NOT_FOUND answer means "free" - anything else is a real PBX problem and
    // must not be silently treated as available.
    if (err instanceof FreePBXError && err.kind === 'NOT_FOUND') return false;
    throw err;
  }
}

/** The PBX's own words for "that number is taken" (builds differ in wording). */
function isDuplicateExtensionError(err: unknown): boolean {
  if (!(err instanceof FreePBXError)) return false;
  const text = `${err.message} ${JSON.stringify(err.detail ?? {})}`;
  return /already in use|already exists|duplicate/i.test(text);
}

/** How many candidates the allocator may reject before giving up. */
const MAX_EXTENSION_ATTEMPTS = 25;

export async function provisionSipAccount(
  userId: string,
  opts: { actorId?: string; sipPassword?: string; requestId?: string | null } = {},
): Promise<ProvisionResult> {
  const existing = await getSipAccountByUser(userId);
  if (existing && existing.status !== 'DELETED') {
    const credentials = await revealCredentials(existing.id, { ownerUserId: userId, actorId: opts.actorId ?? null, reason: 'provision-existing' });
    return { account: existing, credentials };
  }

  const password = opts.sipPassword ?? generateSipPassword();
  const endpoint = sipEndpointConfig();

  /*
   * Candidate selection is PBX-aware. `findFreeExtension` answers from our own
   * tables; before writing anything we also ask the PBX whether the number is
   * already taken. A taken number is skipped (recorded in `skip`, never
   * overwritten) and the next candidate is tried, so a hand-made extension or a
   * leftover from an earlier failure cannot wedge provisioning for a user.
   */
  const pbx = getFreePBX();
  const skip = new Set<string>();
  let extension: string | null = null;
  let pbxWarning: string | undefined;
  let lastCollision: string | null = null;

  /** Phase 1 - reserve the lowest usable extension (short transaction, advisory lock). */
  const reserveExtension = async (): Promise<string> =>
    withTransaction(
      async (client) =>
        withAdvisoryLock(client, LOCK_KEYS.EXTENSION_POOL, async () => {
          const ext = await findFreeExtension(client, skip);
          // An extension that was allocated before and released is free again, and
          // `extension_allocations` is keyed by extension (one row per number, kept
          // as history), so the row is *reclaimed* rather than inserted. The
          // `WHERE released_at IS NOT NULL` guard means a live allocation can never
          // be stolen: in that (racy) case the update matches nothing and we fail
          // loudly instead of handing the same extension to two users.
          const allocation = await client.query<{ extension: string }>(
            `INSERT INTO extension_allocations (extension, user_id, reason)
             VALUES ($1,$2,$3)
             ON CONFLICT (extension) DO UPDATE
                SET user_id = EXCLUDED.user_id,
                    allocated_at = now(),
                    released_at = NULL,
                    reason = EXCLUDED.reason
              WHERE extension_allocations.released_at IS NOT NULL
             RETURNING extension`,
            [ext, userId, 'provision'],
          );
          if (allocation.rows.length === 0) {
            throw new AppError('CONFLICT', `Extension ${ext} was taken by another request. Please retry.`);
          }
          await client.query(
            `INSERT INTO sip_accounts (user_id, extension, technology, sip_server, sip_port, sip_transport, sip_domain,
                                       display_name, password_encrypted, status)
             VALUES ($1,$2,'pjsip',$3,$4,$5,$6,$7,$8,'PROVISIONING')`,
            [
              userId,
              ext,
              endpoint.server,
              endpoint.port,
              endpoint.transport,
              endpoint.domain,
              await displayNameForUser(userId),
              encryptSecret(password),
            ],
          );
          return ext;
        }),
      // READ COMMITTED on purpose: the advisory lock is the serialisation point,
      // and each statement must see rows committed while we were waiting for it.
      { isolation: 'READ COMMITTED', lockTimeoutMs: 5_000 },
    );

  /** Undoes phase 1 so the extension number stays reusable (spec §36). */
  const releaseProvisioning = async (ext: string, reason: string): Promise<void> => {
    await query('DELETE FROM sip_accounts WHERE user_id = $1 AND extension = $2', [userId, ext]);
    await query('UPDATE extension_allocations SET released_at = now(), reason = $2 WHERE extension = $1', [
      ext,
      reason.slice(0, 200),
    ]);
  };

  for (let attempt = 1; attempt <= MAX_EXTENSION_ATTEMPTS && extension === null; attempt += 1) {
    const candidate = await reserveExtension();

    // Phase 2 - create it on the PBX (network, outside the transaction).
    const jobId = await enqueueJob({
      jobType: 'EXTENSION_CREATE',
      entityType: 'sip_account',
      entityId: userId,
      idempotencyKey: `ext-create:${candidate}`,
      payload: { extension: candidate, userId },
    });

    try {
      if (await pbxHasExtension(pbx, candidate)) {
        await releaseProvisioning(candidate, 'already exists on the PBX (not ours)');
        skip.add(candidate);
        logger.warn({ extension: candidate, attempt }, 'extension already exists on the PBX; trying the next candidate');
        continue;
      }

      const created = await pbx.createExtension(
        {
          extensionId: candidate,
          name: await displayNameForUser(userId),
          tech: 'pjsip',
          email: `ext-${candidate}@invalid.local`,
          ...(env.freepbx.defaultOutboundCid ? { outboundCid: env.freepbx.defaultOutboundCid } : {}),
          callerId: await displayNameForUser(userId),
          vmEnable: false,
          maxContacts: 2,
          clientMutationId: `sipbot-${candidate}`,
        },
        { sipPassword: password },
      );
      if (created.message && /PBX-generated/i.test(created.message)) {
        pbxWarning = 'The PBX generated the SIP password itself; the value shown is the one reported by the PBX.';
      }
      const _jobId = jobId;
      logger.info({ extension: candidate, userId, attempt }, 'PBX extension created');
      extension = candidate;
    } catch (err) {
      if (isDuplicateExtensionError(err)) {
        // Somebody (or an earlier half-finished attempt) already holds the number.
        lastCollision = candidate;
        await releaseProvisioning(candidate, `already in use on the PBX: ${(err as Error).message.slice(0, 120)}`);
        skip.add(candidate);
        logger.warn({ extension: candidate, attempt }, 'PBX reports this extension is already in use; trying the next candidate');
        continue;
      }

      // A real failure: roll back phase 1 so the extension number is reusable and
      // the user is left in a clean state (spec §36).
      await releaseProvisioning(candidate, `provision failed: ${(err as Error).message.slice(0, 200)}`);
      await writeAudit({
        actorId: opts.actorId ?? null,
        actorType: opts.actorId ? 'ADMIN' : 'SYSTEM',
        action: 'SIP_ACCOUNT_CREATED',
        result: 'FAILURE',
        targetType: 'user',
        targetId: userId,
        targetRef: candidate,
        reason: err instanceof Error ? err.message : String(err),
        requestId: opts.requestId ?? null,
      });
      if (err instanceof FreePBXError) {
        throw new AppError(
          err.kind === 'REJECTED' ? 'PBX_REJECTED' : 'PBX_UNAVAILABLE',
          err.kind === 'REJECTED'
            ? `FreePBX rejected the extension: ${err.message}`
            : 'The PBX is unreachable, so the SIP account could not be created. Nothing was left half-configured - please retry.',
          { cause: err },
        );
      }
      throw err;
    }
  }

  if (extension === null) {
    throw new AppError(
      'NO_INVENTORY',
      `No free SIP extension could be found in ${env.freepbx.extensionRange.start}-${env.freepbx.extensionRange.end}: ` +
        `${MAX_EXTENSION_ATTEMPTS} candidates are already used on the PBX` +
        `${lastCollision ? ` (last one: ${lastCollision})` : ''}. Widen EXTENSION_RANGE_* or remove unused extensions in FreePBX.`,
    );
  }

  // --- Phase 3: mark active in the database ---------------------------------
  const account = await one<SipAccountRow>(
    `UPDATE sip_accounts
        SET status = 'ACTIVE', last_sync_at = now()
      WHERE user_id = $1 AND extension = $2 AND deleted_at IS NULL
      RETURNING *`,
    [userId, extension],
  );
  if (!account) throw notFound('SIP account after provisioning');

  await withTransaction(async (client) => {
    await writeAudit({
      client,
      actorId: opts.actorId ?? null,
      actorType: opts.actorId ? 'ADMIN' : 'SYSTEM',
      action: 'SIP_ACCOUNT_CREATED',
      targetType: 'sip_account',
      targetId: account.id,
      targetRef: extension,
      metadata: { technology: 'pjsip', userId },
      requestId: opts.requestId ?? null,
    });
  });

  return {
    account,
    credentials: {
      extension,
      password,
      server: endpoint.server,
      port: endpoint.port,
      transport: endpoint.transport,
      domain: endpoint.domain,
    },
    ...(pbxWarning ? { pbxWarning } : {}),
  };
}

async function displayNameForUser(userId: string): Promise<string> {
  const row = await one<{ display_name: string | null; username: string | null; telegram_id: number | null }>(
    'SELECT display_name, username, telegram_id FROM users WHERE id = $1',
    [userId],
  );
  return row?.display_name || row?.username || `user-${String(row?.telegram_id ?? userId).slice(0, 8)}`;
}

export async function getSipAccountByUser(userId: string): Promise<SipAccountRow | null> {
  return one<SipAccountRow>(
    "SELECT * FROM sip_accounts WHERE user_id = $1 AND deleted_at IS NULL AND status <> 'DELETED' ORDER BY created_at DESC LIMIT 1",
    [userId],
  );
}

export async function getSipAccountByExtension(extension: string): Promise<SipAccountRow | null> {
  return one<SipAccountRow>('SELECT * FROM sip_accounts WHERE extension = $1 AND deleted_at IS NULL', [extension]);
}

export async function listSipAccountsWithUser(limit = 20, offset = 0): Promise<Array<SipAccountRow & { username: string | null; telegram_id: number | null }>> {
  return many<SipAccountRow & { username: string | null; telegram_id: number | null }>(
    `SELECT s.*, u.username, u.telegram_id
       FROM sip_accounts s JOIN users u ON u.id = s.user_id
      WHERE s.deleted_at IS NULL AND s.status <> 'DELETED'
      ORDER BY s.created_at DESC LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
}

/**
 * Reveals the SIP password.
 *
 * Access control is enforced HERE, not in the handlers:
 *   * the owner may always read their own credentials;
 *   * an admin may read them with an explicit reason (audited as
 *     SIP_PASSWORD_VIEWED so "who looked at whose password" is provable).
 */
export async function revealCredentials(
  sipAccountId: string,
  opts: { ownerUserId?: string | null; actorId?: string | null; reason?: string },
): Promise<SipCredentials> {
  const account = await one<SipAccountRow & { password_encrypted: string }>(
    'SELECT * FROM sip_accounts WHERE id = $1 AND deleted_at IS NULL',
    [sipAccountId],
  );
  if (!account) throw notFound('SIP account');

  const isOwner = opts.ownerUserId && account.user_id === opts.ownerUserId;
  if (!isOwner && !opts.actorId) throw new AppError('FORBIDDEN', 'You cannot view these credentials.');

  if (!isOwner && opts.actorId) {
    await writeAudit({
      actorId: opts.actorId,
      actorType: 'ADMIN',
      action: 'SIP_PASSWORD_VIEWED',
      targetType: 'sip_account',
      targetId: account.id,
      targetRef: account.extension,
      reason: opts.reason ?? 'admin credential view',
      metadata: { userId: account.user_id },
    });
  }

  const endpoint = sipEndpointConfig();
  return {
    extension: account.extension,
    password: decryptSecret(account.password_encrypted),
    server: account.sip_server ?? endpoint.server,
    port: account.sip_port ?? endpoint.port,
    transport: account.sip_transport ?? endpoint.transport,
    domain: account.sip_domain ?? endpoint.domain,
  };
}

export async function rotateSipPassword(
  userId: string,
  opts: { actorId?: string; requestId?: string | null } = {},
): Promise<SipCredentials> {
  const account = await getSipAccountByUser(userId);
  if (!account) throw notFound('SIP account');

  const password = generateSipPassword();
  const pbx = getFreePBX();

  await enqueueJob({
    jobType: 'EXTENSION_UPDATE',
    entityType: 'sip_account',
    entityId: account.id,
    idempotencyKey: `ext-rotate:${account.extension}:${Date.now()}`,
    payload: { extension: account.extension },
  });

  await pbx.updateExtension({ extensionId: account.extension, name: await displayNameForUser(userId), extPassword: password });

  await query('UPDATE sip_accounts SET password_encrypted = $2, last_sync_at = now() WHERE id = $1', [
    account.id,
    encryptSecret(password),
  ]);

  await writeAudit({
    actorId: opts.actorId ?? userId,
    actorType: opts.actorId ? 'ADMIN' : 'USER',
    action: 'SIP_PASSWORD_ROTATED',
    targetType: 'sip_account',
    targetId: account.id,
    targetRef: account.extension,
    requestId: opts.requestId ?? null,
  });

  const endpoint = sipEndpointConfig();
  return {
    extension: account.extension,
    password,
    server: account.sip_server ?? endpoint.server,
    port: account.sip_port ?? endpoint.port,
    transport: account.sip_transport ?? endpoint.transport,
    domain: account.sip_domain ?? endpoint.domain,
  };
}

/**
 * Deletes the SIP account. Refuses while the user still holds numbers, because
 * deleting the extension would silently break their inbound routes (spec §17).
 */
export async function deleteSipAccount(
  userId: string,
  opts: { actorId: string; force?: boolean; requestId?: string | null },
): Promise<void> {
  const account = await getSipAccountByUser(userId);
  if (!account) return;

  const active = await one<{ count: string }>(
    `SELECT count(*)::text AS count FROM numbers
      WHERE assigned_user_id = $1 AND status IN ('ASSIGNED','SUSPENDED') AND deleted_at IS NULL`,
    [userId],
  );
  if (Number(active?.count ?? 0) > 0 && !opts.force) {
    throw conflict('This user still holds numbers. Release them before deleting the SIP account.');
  }

  const pbx = getFreePBX();
  await enqueueJob({
    jobType: 'EXTENSION_DELETE',
    entityType: 'sip_account',
    entityId: account.id,
    idempotencyKey: `ext-delete:${account.extension}`,
    payload: { extension: account.extension },
  });

  try {
    await pbx.deleteExtension(account.extension);
  } catch (err) {
    // A missing extension is a success for our purposes (idempotent delete).
    if (!(err instanceof FreePBXError) || err.kind !== 'NOT_FOUND') {
      logger.warn({ extension: account.extension, err: (err as Error).message }, 'PBX extension delete failed; queued for reconciliation');
    }
  }

  await query("UPDATE sip_accounts SET status = 'DELETED', deleted_at = now() WHERE id = $1", [account.id]);
  await query('UPDATE extension_allocations SET released_at = now(), reason = $2 WHERE extension = $1 AND released_at IS NULL', [
    account.extension,
    'sip account deleted',
  ]);

  await writeAudit({
    actorId: opts.actorId,
    actorType: 'ADMIN',
    action: 'SIP_ACCOUNT_DELETED',
    targetType: 'sip_account',
    targetId: account.id,
    targetRef: account.extension,
    requestId: opts.requestId ?? null,
  });
}

/** Extensions that exist in the PBX but not in our database (or vice versa). */
export async function compareExtensionInventory(pbxExtensions: string[]): Promise<{
  missingInPbx: string[];
  missingInDb: string[];
}> {
  const local = await many<{ extension: string }>(
    `SELECT extension FROM sip_accounts WHERE deleted_at IS NULL AND status <> 'DELETED'`,
  );
  const localSet = new Set(local.map((r) => r.extension));
  const pbxSet = new Set(pbxExtensions);
  return {
    missingInPbx: [...localSet].filter((e) => !pbxSet.has(e)),
    missingInDb: [...pbxSet].filter((e) => !localSet.has(e)),
  };
}
