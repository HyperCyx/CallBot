import { describe, expect, it } from 'vitest';
import { query } from '../src/db/pool.js';
import { verifyAuditChain } from '../src/db/migrate.js';
import { countAuditLogs, listAuditLogs, scrubMetadata, writeAudit } from '../src/services/audit.service.js';

/**
 * Audit log integrity (spec §34).
 *
 * The audit log is the evidence trail for every number assignment, credential
 * read and admin action, so it must be tamper-evident: append-only in practice
 * (trigger) and verifiable afterwards (hash chain).
 */

describe('audit log: append-only + hash chain', () => {
  it('appends rows and keeps the chain verifiable', async () => {
    await writeAudit({ actorType: 'SYSTEM', action: 'USER_REGISTERED', targetType: 'user', targetId: null, reason: 'test row 1' });
    await writeAudit({ actorType: 'SYSTEM', action: 'USER_APPROVED', targetType: 'user', targetId: null, reason: 'test row 2' });
    await writeAudit({ actorType: 'SYSTEM', action: 'NUMBER_ASSIGNMENT_FAILED', targetType: 'number', targetId: null, reason: 'test row 3' });

    expect(await countAuditLogs()).toBe(3);
    const verification = await verifyAuditChain();
    expect(verification.ok).toBe(true);
    expect(verification.checked).toBe(3);
  });

  it('rejects UPDATE of an audit row (append-only trigger)', async () => {
    await writeAudit({ actorType: 'SYSTEM', action: 'USER_REGISTERED', targetType: 'user', targetId: null, reason: 'immutable' });
    await expect(query("UPDATE audit_logs SET reason = 'tampered'")).rejects.toThrow(/append-only|immutable/i);
    expect(await countAuditLogs()).toBe(1);
  });

  it('rejects DELETE of an audit row', async () => {
    await writeAudit({ actorType: 'SYSTEM', action: 'USER_REGISTERED', targetType: 'user', targetId: null, reason: 'undeletable' });
    await expect(query('DELETE FROM audit_logs')).rejects.toThrow(/append-only|immutable/i);
    expect(await countAuditLogs()).toBe(1);
  });

  it('detects tampering that happened with triggers disabled', async () => {
    await writeAudit({ actorType: 'SYSTEM', action: 'USER_REGISTERED', targetType: 'user', targetId: null, reason: 'original' });
    await writeAudit({ actorType: 'SYSTEM', action: 'USER_APPROVED', targetType: 'user', targetId: null, reason: 'second' });
    expect((await verifyAuditChain()).ok).toBe(true);

    // Simulate a DBA/compromised-app rewrite: bypass the trigger, then re-verify.
    // `reason` is inside the chain as of migration 011, so this must be caught.
    await query('SET session_replication_role = replica');
    await query("UPDATE audit_logs SET reason = 'rewritten' WHERE id = (SELECT id FROM audit_logs ORDER BY id LIMIT 1)");
    await query("UPDATE audit_logs SET metadata = '{\"injected\":true}'::jsonb WHERE id = (SELECT id FROM audit_logs ORDER BY id LIMIT 1)");
    await query('SET session_replication_role = origin');

    const verification = await verifyAuditChain();
    expect(verification.ok).toBe(false);
  });

  it('filters by action and actor for the admin audit view', async () => {
    await writeAudit({ actorType: 'SYSTEM', action: 'USER_REGISTERED', targetType: 'user', targetId: null, reason: 'a' });
    await writeAudit({ actorType: 'ADMIN', action: 'NUMBER_SUSPENDED', targetType: 'number', targetId: null, reason: 'b' });

    const onlySuspended = await listAuditLogs({ action: 'NUMBER_SUSPENDED' });
    expect(onlySuspended).toHaveLength(1);
    expect(onlySuspended[0]?.action).toBe('NUMBER_SUSPENDED');
    expect(onlySuspended[0]?.actor_type).toBe('ADMIN');
    expect(await listAuditLogs({ limit: 1 })).toHaveLength(1);
  });

  it('never stores a SIP password in audit metadata (spec §33)', async () => {
    await writeAudit({
      actorType: 'ADMIN',
      action: 'SIP_ACCOUNT_CREATED',
      targetType: 'sip_account',
      targetId: null,
      metadata: { extension: '10000', password: 'hunter2', nested: { apiToken: 'tok_live_123' } },
    });
    const row = (await listAuditLogs({ limit: 1 }))[0];
    const metadata = JSON.stringify(row?.metadata ?? {});
    expect(metadata).not.toContain('hunter2');
    expect(metadata).not.toContain('tok_live_123');
    expect(metadata).toContain('[REDACTED]');
  });

  it('scrubs deeply nested structures without hanging on cycles', () => {
    const cyclic: Record<string, unknown> = { name: 'root' };
    cyclic.self = cyclic;
    const scrubbed = scrubMetadata(cyclic) as Record<string, unknown>;
    expect(scrubbed.name).toBe('root');
    // Recursion is depth-limited: identifiers such as user ids can appear in
    // reference cycles, and the scrubber must never hang or throw because of it.
    expect(JSON.stringify(scrubbed)).toContain('[truncated]');
  });
});
