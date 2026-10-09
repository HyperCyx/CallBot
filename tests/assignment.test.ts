import { describe, expect, it } from 'vitest';
import { assignNumber, reassignNumber, releaseNumber, suspendNumber, unsuspendNumber } from '../src/services/assignment.service.js';
import { provisionSipAccount } from '../src/services/extension.service.js';
import { AppError } from '../src/lib/errors.js';
import { FreePBXError } from '../src/freepbx/types.js';
import {
  addNumbersToInventory,
  auditActions,
  countActiveAssignments,
  createSipAccount,
  createUser,
  getCountryId,
  getNumberRow,
  getRouteForNumber,
  getServiceId,
  mockPbx,
} from './helpers.js';
import { query } from '../src/db/pool.js';
import { listNumbersForUser } from '../src/services/inventory.service.js';

/**
 * SPEC §39 - the tests that matter most.
 *
 * "Especially test: TWO USERS REQUEST THE SAME NUMBER AT EXACTLY THE SAME TIME.
 *  Only one user may receive it."
 */

describe('number assignment', () => {
  it('assigns a number to a user and creates the DID route', async () => {
    const user = await createUser();
    await createSipAccount(user.id, '10001');
    await addNumbersToInventory({ count: 1 });

    const result = await assignNumber({ userId: user.id, countryId: await getCountryId(), serviceId: await getServiceId() });

    expect(result.phoneNumber).toMatch(/^\+971/);
    expect(result.extension).toBe('10001');

    const number = await getNumberRow(result.numberId);
    expect(number?.status).toBe('ASSIGNED');
    expect(number?.assigned_user_id).toBe(user.id);

    const route = await getRouteForNumber(result.numberId);
    expect(route?.status).toBe('ACTIVE');
    expect(route?.destination).toBe('from-did-direct,10001,1');
    // The route must exist on the PBX too, not just in our database.
    const pbxRoutes = await mockPbx().getAllInboundRoutes();
    expect(pbxRoutes.some((r) => r.extension === route?.did_match_pattern)).toBe(true);

    expect(await countActiveAssignments(result.numberId)).toBe(1);
    expect(await auditActions()).toContain('NUMBER_ASSIGNED');
  });

  it('TWO CONCURRENT REQUESTS FOR THE LAST AVAILABLE NUMBER: exactly one winner', async () => {
    const alice = await createUser({ username: 'alice' });
    const bob = await createUser({ username: 'bob' });
    await createSipAccount(alice.id, '10010');
    await createSipAccount(bob.id, '10011');

    // Exactly ONE number is available.
    const [numberId] = await addNumbersToInventory({ count: 1 });

    const [a, b] = await Promise.allSettled([
      assignNumber({ userId: alice.id, countryId: await getCountryId(), serviceId: await getServiceId() }),
      assignNumber({ userId: bob.id, countryId: await getCountryId(), serviceId: await getServiceId() }),
    ]);

    const fulfilled = [a, b].filter((r) => r.status === 'fulfilled');
    const rejected = [a, b].filter((r) => r.status === 'rejected');

    // Exactly one user got it; the other got a clean "no inventory" error.
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(AppError);
    expect(((rejected[0] as PromiseRejectedResult).reason as AppError).code).toBe('NO_INVENTORY');

    // The database invariant: one number, one active assignment, one owner.
    expect(await countActiveAssignments(numberId!)).toBe(1);
    const number = await getNumberRow(numberId!);
    expect(number?.status).toBe('ASSIGNED');

    const assignments = await query<{ user_id: string }>('SELECT user_id FROM number_assignments WHERE number_id = $1 AND released_at IS NULL', [numberId!]);
    expect(assignments.rows).toHaveLength(1);

    // And exactly one route on the PBX for that DID.
    const routes = (await mockPbx().getAllInboundRoutes()).filter((r) => r.extension === number?.phone_number.replace('+', ''));
    expect(routes).toHaveLength(1);
  });

  it('TWO CONCURRENT REQUESTS WITH TWO NUMBERS AVAILABLE: both succeed with different numbers', async () => {
    const alice = await createUser({ username: 'alice2' });
    const bob = await createUser({ username: 'bob2' });
    await createSipAccount(alice.id, '10012');
    await createSipAccount(bob.id, '10013');
    await addNumbersToInventory({ count: 2 });

    const [a, b] = await Promise.all([
      assignNumber({ userId: alice.id, countryId: await getCountryId(), serviceId: await getServiceId() }),
      assignNumber({ userId: bob.id, countryId: await getCountryId(), serviceId: await getServiceId() }),
    ]);

    expect(a.phoneNumber).not.toBe(b.phoneNumber);
    expect(await countActiveAssignments(a.numberId)).toBe(1);
    expect(await countActiveAssignments(b.numberId)).toBe(1);
  });

  it('the partial unique index makes double-assignment impossible even if the service is bypassed', async () => {
    const alice = await createUser({ username: 'alice3' });
    const bob = await createUser({ username: 'bob3' });
    const [numberId] = await addNumbersToInventory({ count: 1 });

    await query(`INSERT INTO number_assignments (number_id, user_id, status) VALUES ($1,$2,'ACTIVE')`, [numberId, alice.id]);

    // Direct SQL, no service involved: the database must refuse the second row.
    await expect(
      query(`INSERT INTO number_assignments (number_id, user_id, status) VALUES ($1,$2,'ACTIVE')`, [numberId, bob.id]),
    ).rejects.toThrow(/uq_number_assignments_active|duplicate key/i);
  });

  it('rolls back the reservation when FreePBX fails, leaving the number AVAILABLE', async () => {
    const user = await createUser();
    await createSipAccount(user.id, '10020');
    const [numberId] = await addNumbersToInventory({ count: 1 });

    mockPbx().failNextOperation('addInboundRoute', 1, 'trunk unreachable', 'NETWORK');

    await expect(
      assignNumber({ userId: user.id, countryId: await getCountryId(), serviceId: await getServiceId() }),
    ).rejects.toMatchObject({ code: 'PBX_UNAVAILABLE' } as never);

    // Spec §36: "The number must remain AVAILABLE."
    const number = await getNumberRow(numberId!);
    expect(number?.status).toBe('AVAILABLE');
    expect(number?.assigned_user_id).toBeNull();

    // The failed attempt leaves an audit trail and no active assignment.
    expect(await countActiveAssignments(numberId!)).toBe(0);
    expect(await auditActions()).toContain('NUMBER_ASSIGNMENT_FAILED');

    // And the number can be assigned again once the PBX recovers.
    const retry = await assignNumber({ userId: user.id, countryId: await getCountryId(), serviceId: await getServiceId() });
    expect(retry.numberId).toBe(numberId);
  });

  it('never assigns a number from a country with no inventory for that service', async () => {
    const user = await createUser();
    await createSipAccount(user.id, '10021');
    await expect(
      assignNumber({ userId: user.id, countryId: await getCountryId(), serviceId: await getServiceId() }),
    ).rejects.toThrow(/No numbers are available/i);
  });

  it('enforces the plan limit for a user (spec §22)', async () => {
    const user = await createUser({ planCode: 'free' }); // free = max 1 number
    await createSipAccount(user.id, '10022');
    await addNumbersToInventory({ count: 3 });

    await assignNumber({ userId: user.id, countryId: await getCountryId(), serviceId: await getServiceId() });

    await expect(
      assignNumber({ userId: user.id, countryId: await getCountryId(), serviceId: await getServiceId() }),
    ).rejects.toMatchObject({ code: 'PLAN_LIMIT' } as never);
  });

  it('does not assign to a blocked user', async () => {
    const user = await createUser({ status: 'BLOCKED' });
    await createSipAccount(user.id, '10023');
    await addNumbersToInventory({ count: 1 });

    await expect(
      assignNumber({ userId: user.id, countryId: await getCountryId(), serviceId: await getServiceId() }),
    ).rejects.toMatchObject({ code: 'ACCOUNT_NOT_ACTIVE' } as never);
  });

  it('refuses to assign when the user has no active SIP account', async () => {
    const user = await createUser();
    await addNumbersToInventory({ count: 1 });
    await expect(
      assignNumber({ userId: user.id, countryId: await getCountryId(), serviceId: await getServiceId() }),
    ).rejects.toMatchObject({ code: 'ACCOUNT_NOT_ACTIVE' } as never);
  });
});

describe('release / suspend / reassign (spec §15, §16, §17)', () => {
  it('release removes the route and frees the number', async () => {
    const user = await createUser();
    await createSipAccount(user.id, '10030');
    await addNumbersToInventory({ count: 1 });
    const assigned = await assignNumber({ userId: user.id, countryId: await getCountryId(), serviceId: await getServiceId() });

    await releaseNumber(assigned.numberId, { actorId: user.id, actorType: 'USER', reason: 'test release' });

    const number = await getNumberRow(assigned.numberId);
    expect(number?.status).toBe('AVAILABLE');
    expect(number?.assigned_user_id).toBeNull();

    const route = await getRouteForNumber(assigned.numberId);
    expect(route?.status).toBe('REMOVED');
    expect(await mockPbx().getAllInboundRoutes()).toHaveLength(0);
    expect(await countActiveAssignments(assigned.numberId)).toBe(0);
    expect(await auditActions()).toContain('NUMBER_RELEASED');
  });

  it('suspend removes the route but keeps ownership; unsuspend restores it', async () => {
    const user = await createUser();
    await createSipAccount(user.id, '10031');
    await addNumbersToInventory({ count: 1 });
    const assigned = await assignNumber({ userId: user.id, countryId: await getCountryId(), serviceId: await getServiceId() });

    await suspendNumber(assigned.numberId, { actorId: user.id, reason: 'abuse review' });

    let number = await getNumberRow(assigned.numberId);
    expect(number?.status).toBe('SUSPENDED');
    expect(number?.assigned_user_id).toBe(user.id);
    expect(await mockPbx().getAllInboundRoutes()).toHaveLength(0);
    expect(await auditActions()).toContain('NUMBER_SUSPENDED');

    await unsuspendNumber(assigned.numberId, { actorId: user.id });
    number = await getNumberRow(assigned.numberId);
    expect(number?.status).toBe('ASSIGNED');
    expect(await mockPbx().getAllInboundRoutes()).toHaveLength(1);
  });

  it('reassignment moves the DID and never leaves a stale route behind', async () => {
    const alice = await createUser({ username: 'alice-re' });
    const bob = await createUser({ username: 'bob-re' });
    await createSipAccount(alice.id, '10040');
    await createSipAccount(bob.id, '10041');
    await addNumbersToInventory({ count: 1 });
    const assigned = await assignNumber({ userId: alice.id, countryId: await getCountryId(), serviceId: await getServiceId() });

    const moved = await reassignNumber(assigned.numberId, bob.id, { actorId: alice.id, reason: 'test' });

    expect(moved.extension).toBe('10041');
    const number = await getNumberRow(assigned.numberId);
    expect(number?.assigned_user_id).toBe(bob.id);

    const routes = await mockPbx().getAllInboundRoutes();
    // Exactly one route for the DID, pointing at the new extension.
    expect(routes).toHaveLength(1);
    expect(routes[0]?.destinationConnection).toContain('10041');
    expect(await countActiveAssignments(assigned.numberId)).toBe(1);
    expect(await auditActions()).toContain('NUMBER_REASSIGNED');
  });

  it('cannot release a number twice', async () => {
    const user = await createUser();
    await createSipAccount(user.id, '10050');
    await addNumbersToInventory({ count: 1 });
    const assigned = await assignNumber({ userId: user.id, countryId: await getCountryId(), serviceId: await getServiceId() });

    await releaseNumber(assigned.numberId, { actorId: user.id, actorType: 'USER', reason: 'first' });
    // Second release is a no-op rather than an error (idempotent by design),
    // but it must not create a second assignment or fail on the unique index.
    await releaseNumber(assigned.numberId, { actorId: user.id, actorType: 'USER', reason: 'second' });
    expect(await countActiveAssignments(assigned.numberId)).toBe(0);
  });
});

describe('FreePBX error handling (spec §36, §40)', () => {
  it('surfaces PBX rejection without leaving partial state', async () => {
    const user = await createUser();
    await createSipAccount(user.id, '10060');
    const [numberId] = await addNumbersToInventory({ count: 1 });

    mockPbx().failNextOperation('addInboundRoute', 1, 'destination invalid', 'REJECTED');

    await expect(
      assignNumber({ userId: user.id, countryId: await getCountryId(), serviceId: await getServiceId() }),
    ).rejects.toMatchObject({ code: 'PBX_REJECTED' } as never);

    expect((await getNumberRow(numberId!))?.status).toBe('AVAILABLE');
  });

  it('reports a missing extension as a verifiable condition rather than crashing', async () => {
    const user = await createUser();
    await createSipAccount(user.id, '10061');
    await addNumbersToInventory({ count: 1 });
    const assigned = await assignNumber({ userId: user.id, countryId: await getCountryId(), serviceId: await getServiceId() });

    // Simulate somebody deleting the extension directly on the PBX.
    await mockPbx().deleteExtension(assigned.extension);

    const { verifyAssignmentExtension } = await import('../src/services/assignment.service.js');
    expect(await verifyAssignmentExtension(assigned.extension)).toBe(false);
  });

  it('a NOT_FOUND on route deletion is treated as success (idempotent)', async () => {
    const user = await createUser();
    await createSipAccount(user.id, '10062');
    await addNumbersToInventory({ count: 1 });
    const assigned = await assignNumber({ userId: user.id, countryId: await getCountryId(), serviceId: await getServiceId() });

    // Remove it out-of-band, then release: the service must cope.
    const route = await getRouteForNumber(assigned.numberId);
    await mockPbx().deleteInboundRoute(route!.freepbx_route_id!);

    await releaseNumber(assigned.numberId, { actorId: user.id, actorType: 'ADMIN', reason: 'out-of-band removal' });
    expect((await getNumberRow(assigned.numberId))?.status).toBe('AVAILABLE');
  });
});

describe('extension provisioning', () => {
  it('allocates unique extensions even when two users are provisioned at once', async () => {
    const { provisionSipAccount } = await import('../src/services/extension.service.js');
    const a = await createUser({ username: 'prov-a' });
    const b = await createUser({ username: 'prov-b' });

    const [first, second] = await Promise.all([provisionSipAccount(a.id), provisionSipAccount(b.id)]);

    expect(first.credentials.extension).not.toBe(second.credentials.extension);
    expect(first.credentials.password).toMatch(/^[A-Za-z0-9!@#$^*?+.\-~]{12}$/);
    // The secrets are stored encrypted, never in plain text.
    const stored = await query<{ password_encrypted: string }>('SELECT password_encrypted FROM sip_accounts WHERE user_id = $1', [a.id]);
    expect(stored.rows[0]?.password_encrypted).toMatch(/^v1:/);
    expect(stored.rows[0]?.password_encrypted).not.toContain(first.credentials.password);
  });

  it('a user-rotated SIP password is also 12 mixed characters (operator requirement)', async () => {
    const { provisionSipAccount, rotateSipPassword, revealCredentials } = await import('../src/services/extension.service.js');
    const user = await createUser({ username: 'rotator' });
    const provisioned = await provisionSipAccount(user.id);
    expect(provisioned.credentials.password).toMatch(/^[A-Za-z0-9!@#$^*?+.\-~]{12}$/);

    const rotated = await rotateSipPassword(user.id, { actorId: user.id });
    expect(rotated.password).toMatch(/^[A-Za-z0-9!@#$^*?+.\-~]{12}$/);
    expect(rotated.password).not.toBe(provisioned.credentials.password);

    const { getSipAccountByUser } = await import('../src/services/extension.service.js');
    const account = await getSipAccountByUser(user.id);
    const revealed = await revealCredentials(account!.id, { ownerUserId: user.id, reason: 'test' });
    expect(revealed.password).toBe(rotated.password);
    // ...and the stored secret is the new one, encrypted.
    const stored = await query<{ password_encrypted: string }>('SELECT password_encrypted FROM sip_accounts WHERE user_id = $1', [user.id]);
    expect(stored.rows[0]?.password_encrypted).toMatch(/^v1:/);
    expect(stored.rows[0]?.password_encrypted).not.toContain(rotated.password);
  });

  it('recycles an extension after the account is deleted (regression: migration 013)', async () => {
    const { provisionSipAccount, deleteSipAccount } = await import('../src/services/extension.service.js');
    const first = await createUser({ username: 'recycle-1' });
    const second = await createUser({ username: 'recycle-2' });

    const provisioned = await provisionSipAccount(first.id);
    const extension = provisioned.credentials.extension;

    // Deleting the account frees the extension: the historical row is kept, but
    // it must not block the number from being handed to someone else.
    await deleteSipAccount(first.id, { actorId: first.id, force: true });

    const reProvisioned = await provisionSipAccount(first.id);
    expect(reProvisioned.credentials.extension).toBe(extension);

    await deleteSipAccount(first.id, { actorId: first.id, force: true });
    const other = await provisionSipAccount(second.id);
    expect(other.credentials.extension).toBe(extension);

    // Only one live account holds the extension at a time.
    const live = await query<{ count: string }>(
      "SELECT count(*)::text AS count FROM sip_accounts WHERE extension = $1 AND deleted_at IS NULL",
      [extension],
    );
    expect(live.rows[0]?.count).toBe('1');
  });

  it('refuses to hand out an extension that another account still holds', async () => {
    const { provisionSipAccount } = await import('../src/services/extension.service.js');
    const user = await createUser({ username: 'holder' });
    const { credentials } = await provisionSipAccount(user.id);

    // Simulate the racy path: a second live row for the same extension must be
    // rejected by the database, not silently accepted.
    const clash = await query(
      `INSERT INTO sip_accounts (user_id, extension, technology, sip_server, sip_port, sip_transport, sip_domain,
                                 display_name, password_encrypted, status)
       VALUES ($1,$2,'pjsip','pbx.test',5060,'UDP','pbx.test','dup','v1:x:y:z','ACTIVE')`,
      [(await createUser({ username: 'thief' })).id, credentials.extension],
    ).catch((err: Error) => err);
    expect(clash).toBeInstanceOf(Error);
    expect((clash as Error).message).toMatch(/uq_sip_accounts_extension_live|duplicate key/i);
  });

  it('rotates the password on the PBX and in the database', async () => {
    const { provisionSipAccount, rotateSipPassword, revealCredentials } = await import('../src/services/extension.service.js');
    const user = await createUser({ username: 'rot' });
    const provisioned = await provisionSipAccount(user.id);

    const rotated = await rotateSipPassword(user.id);
    expect(rotated.password).not.toBe(provisioned.credentials.password);
    expect(rotated.extension).toBe(provisioned.credentials.extension);

    const account = await query<{ id: string }>('SELECT id FROM sip_accounts WHERE user_id = $1', [user.id]);
    const revealed = await revealCredentials(account.rows[0]!.id, { ownerUserId: user.id });
    expect(revealed.password).toBe(rotated.password);

    // The mock PBX received the new secret too.
    const ext = await mockPbx().getExtension(provisioned.credentials.extension);
    expect(ext?.user?.extPassword).toBe(rotated.password);
  });

  it('refuses to reveal credentials to a non-owner without an actor', async () => {
    const { provisionSipAccount, revealCredentials } = await import('../src/services/extension.service.js');
    const owner = await createUser({ username: 'owner' });
    const stranger = await createUser({ username: 'stranger' });
    await provisionSipAccount(owner.id);

    const account = await query<{ id: string }>('SELECT id FROM sip_accounts WHERE user_id = $1', [owner.id]);
    await expect(revealCredentials(account.rows[0]!.id, { ownerUserId: stranger.id })).rejects.toMatchObject({ code: 'FORBIDDEN' } as never);
  });
});

/**
 * Live-PBX behaviour of the allocator.
 *
 * The extension range is shared with everything an operator created by hand in
 * the FreePBX GUI, and an interrupted job can leave an extension behind. Our
 * database only knows what *we* allocated, so the PBX is asked directly and a
 * taken number is skipped rather than reused or overwritten.
 */
describe('PBX-aware extension allocation', () => {
  it('skips an extension the PBX already owns and takes the next one', async () => {
    const user = await createUser();
    const pbx = mockPbx();
    // Inside EXTENSION_RANGE, present on the PBX, not ours: the exact situation
    // that used to make provisioning fail with "already exists".
    await pbx.createExtension({ extensionId: '10000', name: 'hand-made', email: 'hand@invalid.local' }, { sipPassword: 'HandMade123' });

    const { account, credentials } = await provisionSipAccount(user.id);

    expect(account.extension).toBe('10001');
    expect(credentials.extension).toBe('10001');
    // The pre-existing extension is untouched, and it never entered our DB.
    const untouched = await pbx.getExtension('10000');
    expect(untouched?.user?.name).toBe('hand-made');
    expect(untouched?.user?.extPassword).toBe('HandMade123');
    const recorded = await query<{ extension: string }>('SELECT extension FROM sip_accounts WHERE deleted_at IS NULL');
    expect(recorded.rows.map((r) => r.extension)).toEqual(['10001']);
    // The skipped number is not left reserved in our own allocation table either.
    const allocation = await query<{ released_at: Date | null; reason: string }>(
      'SELECT released_at, reason FROM extension_allocations WHERE extension = $1',
      ['10000'],
    );
    expect(allocation.rows[0]?.released_at).not.toBeNull();
  });

  it('retries the next candidate when the PBX itself reports the number as taken', async () => {
    const user = await createUser();
    // The probe cannot know about every race: the PBX may accept our create and
    // still answer "already in use" (another admin got there first).
    mockPbx().failNextOperation('addExtension', 1, 'This device id is already in use', 'REJECTED');

    const { account } = await provisionSipAccount(user.id);

    expect(account.extension).toBe('10001');
    expect(await mockPbx().getExtension('10000')).toBeNull();
  });

  it('gives up with NO_INVENTORY when every candidate is taken on the PBX', async () => {
    const user = await createUser();
    const pbx = mockPbx();
    for (let ext = 10000; ext <= 10024; ext += 1) {
      await pbx.createExtension({ extensionId: String(ext), name: `taken-${ext}`, email: 't@invalid.local' }, { sipPassword: 'Whatever123' });
    }

    await expect(provisionSipAccount(user.id)).rejects.toMatchObject({ code: 'NO_INVENTORY' });
    // Nothing half-written: no SIP account row survives the failed attempt.
    const rows = await query<{ count: string }>('SELECT count(*)::text AS count FROM sip_accounts WHERE deleted_at IS NULL');
    expect(Number(rows.rows[0]?.count)).toBe(0);
  });
});

describe('taking another number replaces the old one (no manual release)', () => {
  it('releases the oldest held number automatically when replaceOldest is set', async () => {
    const user = await createUser();
    await createSipAccount(user.id, '10077');
    const [firstId] = await addNumbersToInventory({ count: 1, startFrom: 66_000_000 });

    const first = await assignNumber({ userId: user.id, numberId: firstId!, source: 'USER', actorId: user.id });
    expect(first.phoneNumber).toBeTruthy();

    const [secondId] = await addNumbersToInventory({ count: 1, startFrom: 66_000_001 });
    const second = await assignNumber({
      userId: user.id,
      numberId: secondId!,
      source: 'USER',
      actorId: user.id,
      replaceOldest: true,
    });

    // The new number is the one now routed...
    expect(second.numberId).toBe(secondId);
    expect(second.replacedNumbers).toEqual([first.phoneNumber]);
    const held = await listNumbersForUser(user.id);
    expect(held.map((n) => n.id)).toEqual([secondId]);

    // ...and the old one went back to inventory, route removed, assignment closed.
    const oldNumber = await getNumberRow(firstId!);
    expect(oldNumber?.status).toBe('AVAILABLE');
    expect(oldNumber?.assigned_user_id).toBeNull();
    const oldRoute = await getRouteForNumber(firstId!);
    expect(oldRoute?.status).toBe('REMOVED');
    const oldAssignment = await query<{ status: string; released_at: Date | null }>(
      'SELECT status, released_at FROM number_assignments WHERE number_id = $1',
      [firstId!],
    );
    expect(oldAssignment.rows[0]?.status).toBe('RELEASED');
    expect(oldAssignment.rows[0]?.released_at).not.toBeNull();

    // The PBX delete happened through the mock, and it is audited.
    const actions = await auditActions();
    expect(actions.filter((a) => a === 'NUMBER_RELEASED').length).toBeGreaterThanOrEqual(1);
  });

  it('still refuses with PLAN_LIMIT when the caller does not ask to replace', async () => {
    const user = await createUser();
    await createSipAccount(user.id, '10078');
    const [firstId] = await addNumbersToInventory({ count: 1, startFrom: 66_000_100 });
    await assignNumber({ userId: user.id, numberId: firstId!, source: 'USER', actorId: user.id });

    const [secondId] = await addNumbersToInventory({ count: 1, startFrom: 66_000_101 });
    await expect(
      assignNumber({ userId: user.id, numberId: secondId!, source: 'USER', actorId: user.id }),
    ).rejects.toMatchObject({ code: 'PLAN_LIMIT' });

    // Nothing moved: the first number is still the user's, the second is free.
    expect((await getNumberRow(firstId!))?.status).toBe('ASSIGNED');
    expect((await getNumberRow(secondId!))?.status).toBe('AVAILABLE');
  });

  it('a failed assignment never costs the user their existing number', async () => {
    const user = await createUser();
    await createSipAccount(user.id, '10079');
    const [firstId] = await addNumbersToInventory({ count: 1, startFrom: 66_000_200 });
    await assignNumber({ userId: user.id, numberId: firstId!, source: 'USER', actorId: user.id });

    // No second number exists: the replacement attempt fails before anything is
    // released.
    await expect(
      assignNumber({ userId: user.id, countryId: await getCountryId(), serviceId: await getServiceId(), source: 'USER', actorId: user.id, replaceOldest: true }),
    ).rejects.toMatchObject({ code: 'NO_INVENTORY' });

    const stillHeld = await getNumberRow(firstId!);
    expect(stillHeld?.status).toBe('ASSIGNED');
    expect(stillHeld?.assigned_user_id).toBe(user.id);
  });
});
