/**
 * Operator (staff) accounts.
 *
 * The problem this solves: at first boot nobody can approve anybody - the only
 * accounts that exist are the operators', and they are stuck in the same
 * PENDING queue as ordinary applicants. An operator identified by
 * `TELEGRAM_SUPER_ADMIN_IDS` (or holding an admin role row) is therefore
 * activated on the spot, exactly once, with an audit trail that says why.
 *
 * It is deliberately narrow:
 *   * only roles that are already trusted (super_admin / admin / support) qualify;
 *   * `users.approved_by` records the account itself, so the audit log reads
 *     "this account was activated by the operator bootstrap rule", not as if a
 *     colleague had reviewed it;
 *   * a PENDING ordinary user is never touched.
 */
import { logger } from '../../lib/logger.js';
import type { BotContext } from '../context.js';
import { approveUser, findUserForTelegram, resolveRole } from '../../services/user.service.js';
import { provisionSipAccount } from '../../services/extension.service.js';
import { enqueueNotification } from '../../services/notification.service.js';
import { writeAudit } from '../../services/audit.service.js';

export const STAFF_ROLES = ['super_admin', 'admin', 'support'] as const;

export interface ActivationResult {
  /** True when this call changed the account from PENDING to ACTIVE. */
  activated: boolean;
  /** Set when activation happened but SIP provisioning failed. */
  provisioningError?: string;
  extension?: string;
}

/**
 * Activates a staff account that is still PENDING. Safe to call on every /start:
 * it is a no-op for active users, for ordinary users, and for banned ones.
 */
export async function activateStaffAccount(ctx: BotContext): Promise<ActivationResult> {
  const from = ctx.from;
  const user = ctx.state.user;
  if (!from || !user) return { activated: false };

  const role = await resolveRole(from.id, user.id);
  if (!(STAFF_ROLES as readonly string[]).includes(role)) return { activated: false };

  const fresh = await findUserForTelegram(from.id);
  if (!fresh || fresh.status !== 'PENDING') return { activated: false };

  try {
    await approveUser(fresh.id, {
      actorId: fresh.id, // self-activation: the allowlist is the authorisation
      actorTelegramId: from.id,
      requestId: ctx.state.requestId,
    });
    await writeAudit({
      actorId: fresh.id,
      actorTelegramId: from.id,
      actorType: 'ADMIN',
      action: 'USER_APPROVED',
      targetType: 'user',
      targetId: fresh.id,
      targetRef: fresh.username ?? String(fresh.telegram_id),
      reason: `operator bootstrap: ${role} account activated automatically`,
      requestId: ctx.state.requestId,
      metadata: { role, bootstrap: true },
    });
  } catch (err) {
    logger.error({ err: (err as Error).message, userId: fresh.id }, 'could not activate the staff account');
    return { activated: false };
  }

  logger.info({ userId: fresh.id, role }, 'staff account activated on first contact');

  // SIP provisioning is a separate step: a PBX outage must not undo the approval.
  try {
    const provisioned = await provisionSipAccount(fresh.id, { actorId: fresh.id, requestId: ctx.state.requestId });
    await enqueueNotification({
      userId: fresh.id,
      kind: 'USER_APPROVED',
      payload: { extension: provisioned.credentials.extension },
      dedupeKey: `staff-activated:${fresh.id}`,
    });
    // Refresh the cached identity so isAdmin/plan render correctly right away.
    await refreshRole(ctx);
    return { activated: true, extension: provisioned.credentials.extension };
  } catch (err) {
    logger.error({ err: (err as Error).message, userId: fresh.id }, 'staff SIP provisioning failed after activation');
    await refreshRole(ctx);
    return { activated: true, provisioningError: (err as Error).message };
  }
}

/** Re-resolves the cached role/user after a change (avoids a circular import). */
async function refreshRole(ctx: BotContext): Promise<void> {
  const { refreshRole: refresh } = await import('./start.js');
  await refresh(ctx);
}
