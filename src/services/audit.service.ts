import type { DbClient } from '../db/pool.js';
import { query, many } from '../db/pool.js';
import { logger } from '../lib/logger.js';

/**
 * Audit trail (spec §28).
 *
 * Rules enforced here:
 *  * every privileged action is recorded with actor, action, target, result;
 *  * metadata is scrubbed of anything that looks like a credential before it is
 *    written, so the audit log can never become a secret leak (spec §27);
 *  * the table itself is append-only and hash-chained (see migration 009), so a
 *    deleted or edited entry is detectable.
 */

export type AuditAction =
  | 'USER_REGISTERED'
  | 'USER_CAPTCHA_PASSED'
  | 'USER_APPROVED'
  | 'USER_REJECTED'
  | 'USER_BLOCKED'
  | 'USER_UNBLOCKED'
  | 'USER_DELETED'
  | 'USER_PURGED'
  | 'USER_PLAN_CHANGED'
  | 'USER_ROLE_GRANTED'
  | 'USER_ROLE_REVOKED'
  | 'SIP_ACCOUNT_CREATED'
  | 'SIP_ACCOUNT_DELETED'
  | 'SIP_PASSWORD_ROTATED'
  | 'SIP_PASSWORD_VIEWED'
  | 'DEPOSIT_APPROVED'
  | 'DEPOSIT_REJECTED'
  | 'WALLET_ADJUSTED'
  | 'NUMBER_IMPORTED'
  | 'NUMBER_UPDATED'
  | 'NUMBER_DELETED'
  | 'NUMBER_ASSIGNED'
  | 'NUMBER_ASSIGNMENT_FAILED'
  | 'NUMBER_RELEASED'
  | 'NUMBER_SUSPENDED'
  | 'NUMBER_UNSUSPENDED'
  | 'NUMBER_REASSIGNED'
  | 'ROUTE_CREATED'
  | 'ROUTE_UPDATED'
  | 'ROUTE_REMOVED'
  | 'ROUTE_SYNC_FAILED'
  | 'SERVICE_CREATED'
  | 'SERVICE_UPDATED'
  | 'SERVICE_DELETED'
  | 'COUNTRY_CREATED'
  | 'COUNTRY_UPDATED'
  | 'COUNTRY_DELETED'
  | 'PLAN_CREATED'
  | 'PLAN_UPDATED'
  | 'PLAN_DELETED'
  | 'SETTING_UPDATED'
  | 'MEMBERSHIP_SWEEP'
  | 'REFERRAL_QUALIFIED'
  | 'REFERRAL_COMMISSION_CREATED'
  | 'REFERRAL_COMMISSION_PAID'
  | 'REFERRAL_REJECTED'
  | 'REFERRAL_LINK_VIEWED'
  | 'RECONCILIATION_RUN'
  | 'RECONCILIATION_FIX_APPLIED'
  | 'COMPAT_PROBE_RUN'
  | 'ADMIN_ALERT_SENT';

export interface AuditInput {
  actorId?: string | null;
  actorTelegramId?: number | null;
  actorType?: 'USER' | 'ADMIN' | 'SYSTEM' | 'WORKER' | 'API';
  action: AuditAction;
  targetType?: string | null;
  targetId?: string | null;
  targetRef?: string | null;
  result?: 'SUCCESS' | 'FAILURE' | 'DENIED' | 'PARTIAL';
  reason?: string | null;
  metadata?: Record<string, unknown>;
  requestId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  /** When provided, the audit row is written inside the caller's transaction. */
  client?: DbClient;
}

const SENSITIVE_KEY = /pass|secret|token|authorization|credential|kek|key$/i;

/** Recursively strips credential-looking keys and truncates long strings. */
export function scrubMetadata(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[truncated]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return value.length > 500 ? `${value.slice(0, 500)}…` : value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => scrubMetadata(v, depth + 1));
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) ? '[REDACTED]' : scrubMetadata(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

export async function writeAudit(input: AuditInput): Promise<void> {
  const sql = `
    INSERT INTO audit_logs
      (actor_id, actor_telegram_id, actor_type, action, target_type, target_id, target_ref,
       result, reason, metadata, request_id, ip, user_agent)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13)
  `;
  const params = [
    input.actorId ?? null,
    input.actorTelegramId ?? null,
    input.actorType ?? (input.actorId ? 'ADMIN' : 'SYSTEM'),
    input.action,
    input.targetType ?? null,
    input.targetId ?? null,
    input.targetRef ?? null,
    input.result ?? 'SUCCESS',
    input.reason ?? null,
    JSON.stringify(scrubMetadata(input.metadata ?? {})),
    input.requestId ?? null,
    input.ip ?? null,
    input.userAgent ?? null,
  ];

  try {
    if (input.client) await input.client.query(sql, params as never[]);
    else await query(sql, params as never[]);
  } catch (err) {
    // An audit failure must never break the user-facing operation, but it must
    // be loud: it means we made a change we cannot prove.
    logger.error({ err: (err as Error).message, action: input.action }, 'FAILED TO WRITE AUDIT LOG');
  }
}

export interface AuditLogRow {
  id: number;
  actor_id: string | null;
  actor_telegram_id: number | null;
  actor_type: string;
  action: string;
  target_type: string | null;
  target_id: string | null;
  target_ref: string | null;
  result: string;
  reason: string | null;
  metadata: Record<string, unknown>;
  request_id: string | null;
  created_at: Date;
}

export async function listAuditLogs(opts: { limit?: number; offset?: number; action?: string; actorId?: string } = {}): Promise<AuditLogRow[]> {
  const limit = Math.min(opts.limit ?? 20, 100);
  const offset = opts.offset ?? 0;
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (opts.action) {
    params.push(opts.action);
    conditions.push(`action = $${params.length}`);
  }
  if (opts.actorId) {
    params.push(opts.actorId);
    conditions.push(`actor_id = $${params.length}`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(limit, offset);
  return many<AuditLogRow>(
    `SELECT * FROM audit_logs ${where} ORDER BY id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
}

export async function countAuditLogs(): Promise<number> {
  const res = await query<{ count: string }>('SELECT count(*)::text AS count FROM audit_logs');
  return Number(res.rows[0]?.count ?? 0);
}
