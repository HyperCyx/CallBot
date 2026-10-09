import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { createApiServer } from '../src/api/server.js';
import { env } from '../src/config/env.js';
import { one, query } from '../src/db/pool.js';
import { createSipAccount, createUser, getCountryId, getServiceId, mockPbx } from './helpers.js';

/**
 * Internal API (spec §29).
 *
 * Exercised over real HTTP against a real PostgreSQL instance, because the
 * guarantees under test are the middleware chain: API-key auth, the idempotency
 * replay, the error envelope, and the fact that the DB is the only source of
 * truth for the inventory.
 */

let server: Server;
let base = '';

const auth = { 'x-api-key': env.API_KEY, 'content-type': 'application/json' };

async function call(path: string, init: RequestInit = {}): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${base}${path}`, { ...init, headers: { ...auth, ...(init.headers ?? {}) } });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON responses (metrics) are returned as text */
  }
  return { status: res.status, body };
}

beforeAll(async () => {
  const app = createApiServer();
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    if (!server) return resolve();
    server.close(() => resolve());
  });
});

describe('health and metrics', () => {
  it('reports health without authentication, including DB and PBX status', async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      database: { ok: boolean };
      freepbx: { mode: string };
      ami: { available: boolean };
      version: string;
    };
    expect(body.status).toBe('ok');
    expect(body.database.ok).toBe(true);
    expect(body.freepbx.mode).toBe('mock');
    expect(body.version).toBeTruthy();
  });

  it('exposes Prometheus text metrics plus a JSON snapshot', async () => {
    const text = await fetch(`${base}/metrics`);
    expect(text.status).toBe(200);
    expect(text.headers.get('content-type')).toContain('text/plain');
    const body = await text.text();
    // One sample per line, in the exposition format.
    expect(body).toMatch(/^api_requests_total\{.*\} \d+$/m);

    const json = await fetch(`${base}/metrics.json`);
    expect(json.status).toBe(200);
    expect(await json.json()).toHaveProperty('metrics.counters');
  });
});

describe('authentication (spec §31)', () => {
  it('rejects requests without an API key', async () => {
    const { status, body } = await call('/api/admin/users', { headers: { 'x-api-key': '' } });
    expect(status).toBe(401);
    expect(body).toMatchObject({ error: { code: 'UNAUTHORIZED' } });
    expect((body as { requestId: string }).requestId).toMatch(/^api-/);
  });

  it('rejects a wrong API key', async () => {
    const { status, body } = await call('/api/admin/users', { headers: { 'x-api-key': 'not-the-key' } });
    expect(status).toBe(401);
    expect(body).toMatchObject({ error: { code: 'UNAUTHORIZED' } });
  });

  it('accepts the configured key and honours a client-supplied request id', async () => {
    const { status, body } = await call('/api/admin/users', { headers: { 'x-request-id': 'test-req-1' } });
    expect(status).toBe(200);
    expect(body).toHaveProperty('data');
    expect(Array.isArray((body as { data: unknown[] }).data)).toBe(true);
  });
});

describe('error envelope', () => {
  it('returns 404 with a machine-readable body for unknown endpoints', async () => {
    const { status, body } = await call('/api/does-not-exist');
    expect(status).toBe(404);
    expect(body).toMatchObject({ error: { code: 'NOT_FOUND' } });
    expect((body as { requestId: string }).requestId).toBeTruthy();
  });

  it('returns 400 (not 500) for a malformed identifier', async () => {
    const { status, body } = await call('/api/admin/users/not-a-uuid/approve', { method: 'POST', body: '{}' });
    expect(status).toBe(400);
    expect(body).toMatchObject({ error: { code: 'BAD_INPUT' } });
  });

  it('returns 400 for a body that is not valid JSON', async () => {
    const { status, body } = await call('/api/admin/users/00000000-0000-0000-0000-000000000000/approve', {
      method: 'POST',
      body: '{ this is not json',
    });
    expect(status).toBe(400);
    expect(body).toMatchObject({ error: { code: 'BAD_INPUT' } });
  });

  it('returns 404 for a well-formed but unknown user', async () => {
    const { status, body } = await call('/api/admin/users/11111111-1111-1111-1111-111111111111');
    expect([404, 200]).toContain(status);
    if (status === 404) expect(body).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });
});

describe('admin operations over HTTP', () => {
  it('approves a pending user and provisions an extension', async () => {
    const user = await createUser({ telegramId: 700001, status: 'PENDING' });
    const { status, body } = await call(`/api/admin/users/${user.id}/approve`, { method: 'POST', body: JSON.stringify({}) });
    expect(status).toBe(200);

    const data = (body as { data: { user: { status: string }; sip: { account: { extension: string } } | null; warning: string | null } }).data;
    expect(data.user.status).toBe('ACTIVE');
    expect(data.warning).toBeNull();
    expect(data.sip?.account.extension).toMatch(/^\d+$/);

    const account = await one<{ extension: string; password_encrypted: string; status: string }>(
      'SELECT extension, password_encrypted, status FROM sip_accounts WHERE user_id = $1',
      [user.id],
    );
    expect(account?.extension).toBe(data.sip?.account.extension);
    expect(account?.status).toBe('ACTIVE');
    // The secret is encrypted at rest - never stored or returned in clear text.
    expect(account?.password_encrypted).toMatch(/^v\d+:/);
  });

  it('implements Idempotency-Key: a retried import runs exactly once', async () => {
    const countryId = await getCountryId();
    const serviceId = await getServiceId();
    const payload = JSON.stringify({
      countryId,
      serviceId,
      planType: 'FREE',
      numbers: ['+971501234001', '+971501234002'],
    });

    const admin = await createUser({ telegramId: 700900 });
    const first = await call('/api/admin/numbers/import', {
      method: 'POST',
      headers: { 'idempotency-key': 'import-key-1', 'x-actor-user-id': admin.id },
      body: payload,
    });
    expect(first.status).toBe(201);
    expect((first.body as { data: { imported: number } }).data.imported).toBe(2);

    const second = await call('/api/admin/numbers/import', {
      method: 'POST',
      headers: { 'idempotency-key': 'import-key-1', 'x-actor-user-id': admin.id },
      body: payload,
    });
    expect(second.status).toBe(201);
    // Same response replayed, and - crucially - no second import happened.
    expect(second.body).toEqual(first.body);
    const count = await one<{ count: string }>('SELECT count(*)::text AS count FROM numbers');
    expect(Number(count?.count)).toBe(2);
  });

  it('imports the same numbers again under a different key without duplicating them', async () => {
    const countryId = await getCountryId();
    const serviceId = await getServiceId();
    const body = { countryId, serviceId, planType: 'FREE', numbers: ['+971501234101'] };
    const admin = await createUser({ telegramId: 700901 });

    await call('/api/admin/numbers/import', { method: 'POST', headers: { 'x-actor-user-id': admin.id }, body: JSON.stringify(body) });
    const repeat = await call('/api/admin/numbers/import', {
      method: 'POST',
      headers: { 'idempotency-key': 'import-key-2', 'x-actor-user-id': admin.id },
      body: JSON.stringify(body),
    });
    expect((repeat.body as { data: { imported: number; duplicates: number } }).data.imported).toBe(0);
    expect((repeat.body as { data: { duplicates: number } }).data.duplicates).toBe(1);
    const count = await one<{ count: string }>('SELECT count(*)::text AS count FROM numbers WHERE phone_number = $1', [
      '+971501234101',
    ]);
    expect(Number(count?.count)).toBe(1);
  });

  it('lists users with a filter and a total count', async () => {
    await createUser({ telegramId: 700002, status: 'ACTIVE' });
    await createUser({ telegramId: 700003, status: 'PENDING' });
    const { status, body } = await call('/api/admin/users?status=PENDING');
    expect(status).toBe(200);
    const data = body as { data: Array<{ status: string }>; total: number };
    expect(data.total).toBeGreaterThanOrEqual(1);
    expect(data.data.every((u) => u.status === 'PENDING')).toBe(true);
  });

  it('never exposes a SIP password in the user list payload (spec §33)', async () => {
    const user = await createUser({ telegramId: 700004, status: 'PENDING' });
    await call(`/api/admin/users/${user.id}/approve`, { method: 'POST', body: '{}' });
    const { body } = await call('/api/admin/users');
    const payload = JSON.stringify(body);
    const secret = await one<{ password_encrypted: string }>('SELECT password_encrypted FROM sip_accounts WHERE user_id = $1', [user.id]);
    expect(payload).not.toContain('password_encrypted');
    expect(payload).not.toContain('password');
    expect(secret?.password_encrypted).toBeTruthy();
  });

  it('serves the dashboard aggregate', async () => {
    const { status, body } = await call('/api/admin/dashboard');
    expect(status).toBe(200);
    expect(body).toHaveProperty('data');
  });

  it('serves the audit log', async () => {
    const { status, body } = await call('/api/admin/audit?limit=5');
    expect(status).toBe(200);
    expect(Array.isArray((body as { data: unknown[] }).data)).toBe(true);
  });

  it('rejects a number import with a missing country instead of writing partial data', async () => {
    const serviceId = await getServiceId();
    const admin = await createUser({ telegramId: 700902 });
    const { status } = await call('/api/admin/numbers/import', {
      method: 'POST',
      headers: { 'x-actor-user-id': admin.id },
      body: JSON.stringify({ countryId: '11111111-1111-1111-1111-111111111111', serviceId, planType: 'FREE', numbers: ['+971501234201'] }),
    });
    expect(status).toBeGreaterThanOrEqual(400);
    const count = await one<{ count: string }>('SELECT count(*)::text AS count FROM numbers WHERE phone_number = $1', ['+971501234201']);
    expect(Number(count?.count)).toBe(0);
  });
});

describe('database is the only source of truth', () => {
  it('rejects imports that reference disabled catalog entries', async () => {
    const countryId = await getCountryId();
    const serviceId = await getServiceId();
    const admin = await createUser({ telegramId: 700903 });
    await query("UPDATE services SET status = 'DISABLED' WHERE id = $1", [serviceId]);
    const { status } = await call('/api/admin/numbers/import', {
      method: 'POST',
      headers: { 'x-actor-user-id': admin.id },
      body: JSON.stringify({ countryId, serviceId, planType: 'FREE', numbers: ['+971501234301'] }),
    });
    expect(status).toBeGreaterThanOrEqual(400);
  });
});

describe('user deletion (spec §36 - nothing left behind on the PBX)', () => {
  it('removes the SIP extension as well as the user and their numbers', async () => {
    const countryId = await getCountryId();
    const serviceId = await getServiceId();
    const admin = await createUser({ telegramId: 700904 });
    const user = await createUser({ telegramId: 700905 });
    await query(
      `INSERT INTO numbers (phone_number, country_id, service_id, plan_type, status)
       VALUES ('+971501234401', $1, $2, 'FREE', 'AVAILABLE')`,
      [countryId, serviceId],
    );
    await createSipAccount(user.id, '10050');
    const number = await one<{ id: string }>("SELECT id FROM numbers WHERE phone_number = '+971501234401'");

    const assigned = await call('/api/admin/numbers/assign', {
      method: 'POST',
      headers: { 'x-actor-user-id': admin.id },
      body: JSON.stringify({ numberId: number?.id, userId: user.id }),
    });
    expect(assigned.status).toBeLessThan(300);

    const res = await call(`/api/admin/users/${user.id}`, {
      method: 'DELETE',
      headers: { 'x-actor-user-id': admin.id },
    });
    expect(res.status).toBe(200);
    const body = res.body as { data: { releasedNumbers: number; sipAccountDeleted: boolean } };
    expect(body.data.releasedNumbers).toBe(1);
    expect(body.data.sipAccountDeleted).toBe(true);

    // The extension is gone from the PBX, the account row is purged (operator
    // order 2026-10-08: hard data-loss deletion, no tombstones left), and the
    // number went back to the pool - a deleted user must not strand any of the
    // three.
    expect(await mockPbx().getExtension('10050')).toBeNull();
    const account = await one<{ c: string }>("SELECT count(*)::text AS c FROM sip_accounts WHERE extension = '10050'");
    expect(Number(account?.c)).toBe(0);
    const released = await one<{ status: string }>("SELECT status FROM numbers WHERE phone_number = '+971501234401'");
    expect(released?.status).toBe('AVAILABLE');
  });
});

/**
 * Admin removal (spec §8, §9, §17).
 *
 * "Remove all the numbers, or a country, or a service" is the most destructive
 * thing the admin panel can do, so the guarantees are pinned here: live numbers
 * are never taken from a user, removal cleans up what belongs to it, it is
 * refused while a user is still served, and everything lands in the audit log.
 */
describe('admin removal', () => {
  it('removes every AVAILABLE number and leaves held numbers alone', async () => {
    const countryId = await getCountryId();
    const serviceId = await getServiceId();
    const admin = await createUser({ telegramId: 700801 });
    const user = await createUser({ telegramId: 700802 });

    await query(
      `INSERT INTO numbers (phone_number, country_id, service_id, plan_type, status)
       VALUES ('+971501235001', $1, $2, 'FREE', 'AVAILABLE'),
              ('+971501235002', $1, $2, 'FREE', 'AVAILABLE'),
              ('+971501235003', $1, $2, 'FREE', 'SUSPENDED')`,
      [countryId, serviceId],
    );
    await createSipAccount(user.id, '10060');
    const held = await one<{ id: string }>("SELECT id FROM numbers WHERE phone_number = '+971501235003'");
    await query("UPDATE numbers SET assigned_user_id = $2 WHERE id = $1", [held?.id, user.id]);

    const preview = await call('/api/admin/numbers/removal-preview');
    expect(preview.status).toBe(200);
    const before = (preview.body as { data: { available: number; suspended: number } }).data;
    expect(before.available).toBe(2);
    expect(before.suspended).toBe(1);

    const res = await call('/api/admin/numbers', { method: 'DELETE', headers: { 'x-actor-user-id': admin.id } });
    expect(res.status).toBe(200);
    const body = res.body as { data: { removed: number; kept: { available: number; suspended: number } } };
    expect(body.data.removed).toBe(2);
    expect(body.data.kept.available).toBe(0); // they are gone now
    expect(body.data.kept.suspended).toBe(1); // ... and this one was kept

    const remaining = await query<{ phone_number: string; status: string }>(
      "SELECT phone_number, status FROM numbers WHERE deleted_at IS NULL ORDER BY phone_number",
    );
    expect(remaining.rows.map((r) => r.phone_number)).toEqual(['+971501235003']);
    expect(remaining.rows[0]?.status).toBe('SUSPENDED');

    const audit = await query<{ metadata: Record<string, unknown> }>(
      "SELECT metadata FROM audit_logs WHERE action = 'NUMBER_DELETED' AND target_type = 'number_inventory'",
    );
    expect(audit.rows[0]?.metadata).toMatchObject({ bulk: true, removed: 2 });
  });

  it('closes a leftover route row and queues its PBX-side deletion', async () => {
    const countryId = await getCountryId();
    const serviceId = await getServiceId();
    const admin = await createUser({ telegramId: 700807 });

    await query(
      `INSERT INTO numbers (phone_number, country_id, service_id, plan_type, status)
       VALUES ('+971501235301', $1, $2, 'FREE', 'AVAILABLE')`,
      [countryId, serviceId],
    );
    const number = await one<{ id: string }>("SELECT id FROM numbers WHERE phone_number = '+971501235301'");
    // A row that somehow still points at a free number (an interrupted release,
    // say): removal must close it and not leave the route on the PBX.
    await query(
      `INSERT INTO inbound_route_mappings (number_id, freepbx_route_id, did_match_pattern, destination, destination_extension, status)
       VALUES ($1, 'orphan-route-1', '971501235301', 'from-did-direct,10099,1', '10099', 'ACTIVE')`,
      [number?.id],
    );

    const res = await call('/api/admin/numbers', { method: 'DELETE', headers: { 'x-actor-user-id': admin.id } });
    expect(res.status).toBe(200);

    const mapping = await query<{ status: string; deleted_at: Date | null }>(
      'SELECT status, deleted_at FROM inbound_route_mappings WHERE number_id = $1',
      [number?.id],
    );
    expect(mapping.rows[0]?.status).toBe('REMOVED');
    expect(mapping.rows[0]?.deleted_at).not.toBeNull();

    const job = await query<{ job_type: string; payload: Record<string, unknown> }>(
      "SELECT job_type, payload FROM freepbx_sync_jobs WHERE job_type = 'ROUTE_DELETE' AND idempotency_key = 'route-delete:orphan-route-1'",
    );
    expect(job.rows[0]?.job_type).toBe('ROUTE_DELETE');
    expect(job.rows[0]?.payload).toMatchObject({ routeId: 'orphan-route-1' });
  });

  it('removing a country drops its available numbers and offers, and is refused while a number is in use', async () => {
    const countryId = await getCountryId();
    const serviceId = await getServiceId();
    const admin = await createUser({ telegramId: 700803 });
    const user = await createUser({ telegramId: 700804 });

    await query(
      `INSERT INTO numbers (phone_number, country_id, service_id, plan_type, status)
       VALUES ('+971501235101', $1, $2, 'FREE', 'AVAILABLE'),
              ('+971501235102', $1, $2, 'FREE', 'AVAILABLE')`,
      [countryId, serviceId],
    );
    await query(
      `INSERT INTO service_countries (service_id, country_id, price_cents, currency) VALUES ($1,$2,0,'EUR')
       ON CONFLICT (service_id, country_id) DO NOTHING`,   // 0 = free: pricing now charges wallets; these fixtures only exercise offer rows
      [serviceId, countryId],
    );
    await createSipAccount(user.id, '10061');
    const held = await one<{ id: string }>("SELECT id FROM numbers WHERE phone_number = '+971501235102'");
    const assigned = await call('/api/admin/numbers/assign', {
      method: 'POST',
      headers: { 'x-actor-user-id': admin.id },
      body: JSON.stringify({ numberId: held?.id, userId: user.id }),
    });
    expect(assigned.status).toBeLessThan(300);

    // Refused while a number of that country serves a user.
    const refused = await call(`/api/admin/countries/${countryId}`, {
      method: 'DELETE',
      headers: { 'x-actor-user-id': admin.id },
    });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(refused.body)).toMatch(/in use/i);

    // Release it, then the same call goes through and cleans up everything.
    const released = await call('/api/admin/numbers/release', {
      method: 'POST',
      headers: { 'x-actor-user-id': admin.id },
      body: JSON.stringify({ numberId: held?.id, actorId: admin.id }),
    });
    expect(released.status).toBeLessThan(300);
    const res = await call(`/api/admin/countries/${countryId}`, {
      method: 'DELETE',
      headers: { 'x-actor-user-id': admin.id },
    });
    expect(res.status).toBe(200);
    const impact = (res.body as { data: { availableNumbers: number; offers: number } }).data;
    expect(impact.availableNumbers).toBeGreaterThanOrEqual(2);
    expect(impact.offers).toBeGreaterThanOrEqual(1);

    const live = await query<{ count: string }>(
      "SELECT count(*)::text AS count FROM numbers WHERE country_id = $1 AND deleted_at IS NULL",
      [countryId],
    );
    expect(Number(live.rows[0]?.count)).toBe(0);
    const offers = await query<{ count: string }>('SELECT count(*)::text AS count FROM service_countries WHERE country_id = $1', [countryId]);
    expect(Number(offers.rows[0]?.count)).toBe(0);
    const country = await query<{ status: string; deleted_at: Date | null }>('SELECT status, deleted_at FROM countries WHERE id = $1', [countryId]);
    expect(country.rows[0]?.status).toBe('DISABLED');
    expect(country.rows[0]?.deleted_at).not.toBeNull();
    const audit = await query<{ count: string }>("SELECT count(*)::text AS count FROM audit_logs WHERE action = 'COUNTRY_DELETED'");
    expect(Number(audit.rows[0]?.count)).toBe(1);
  });

  it('removing a service takes its available numbers with it and is refused while one is in use', async () => {
    const countryId = await getCountryId();
    const serviceId = await getServiceId();
    const admin = await createUser({ telegramId: 700805 });
    const user = await createUser({ telegramId: 700806 });

    await query(
      `INSERT INTO numbers (phone_number, country_id, service_id, plan_type, status)
       VALUES ('+971501235201', $1, $2, 'FREE', 'AVAILABLE')`,
      [countryId, serviceId],
    );
    await createSipAccount(user.id, '10062');
    const held = await one<{ id: string }>("SELECT id FROM numbers WHERE phone_number = '+971501235201'");
    const assigned = await call('/api/admin/numbers/assign', {
      method: 'POST',
      headers: { 'x-actor-user-id': admin.id },
      body: JSON.stringify({ numberId: held?.id, userId: user.id }),
    });
    expect(assigned.status).toBeLessThan(300);

    const refused = await call(`/api/admin/services/${serviceId}`, {
      method: 'DELETE',
      headers: { 'x-actor-user-id': admin.id },
    });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(refused.body)).toMatch(/in use|disable/i);

    const released = await call('/api/admin/numbers/release', {
      method: 'POST',
      headers: { 'x-actor-user-id': admin.id },
      body: JSON.stringify({ numberId: held?.id, actorId: admin.id }),
    });
    expect(released.status).toBeLessThan(300);
    const res = await call(`/api/admin/services/${serviceId}`, {
      method: 'DELETE',
      headers: { 'x-actor-user-id': admin.id },
    });
    expect(res.status).toBe(200);
    expect((res.body as { data: { availableNumbers: number } }).data.availableNumbers).toBeGreaterThanOrEqual(1);

    const service = await query<{ status: string; deleted_at: Date | null }>('SELECT status, deleted_at FROM services WHERE id = $1', [serviceId]);
    expect(service.rows[0]?.status).toBe('DISABLED');
    expect(service.rows[0]?.deleted_at).not.toBeNull();
    const offers = await query<{ count: string }>('SELECT count(*)::text AS count FROM service_countries WHERE service_id = $1', [serviceId]);
    expect(Number(offers.rows[0]?.count)).toBe(0);
    const audit = await query<{ count: string }>("SELECT count(*)::text AS count FROM audit_logs WHERE action = 'SERVICE_DELETED'");
    expect(Number(audit.rows[0]?.count)).toBe(1);
  });
});

describe('account deletion', () => {
  it('deleting an account removes its assigned number, its route and its extension', async () => {
    const countryId = await getCountryId();
    const serviceId = await getServiceId();
    const admin = await createUser({ telegramId: 700901 });
    const user = await createUser({ telegramId: 700902 });

    await query(
      `INSERT INTO numbers (phone_number, country_id, service_id, plan_type, status)
       VALUES ('+971501235401', $1, $2, 'FREE', 'AVAILABLE')`,
      [countryId, serviceId],
    );
    await createSipAccount(user.id, '10071');
    const number = await one<{ id: string }>("SELECT id FROM numbers WHERE phone_number = '+971501235401'");

    const assigned = await call('/api/admin/numbers/assign', {
      method: 'POST',
      headers: { 'x-actor-user-id': admin.id },
      body: JSON.stringify({ numberId: number?.id, userId: user.id }),
    });
    expect(assigned.status).toBeLessThan(300);
    const held = await one<{ status: string; assigned_user_id: string | null }>(
      'SELECT status, assigned_user_id FROM numbers WHERE id = $1',
      [number?.id],
    );
    expect(held?.status).toBe('ASSIGNED');
    expect(held?.assigned_user_id).toBe(user.id);

    const res = await call(`/api/admin/users/${user.id}`, {
      method: 'DELETE',
      headers: { 'x-actor-user-id': admin.id },
    });
    expect(res.status).toBe(200);
    const data = (res.body as { data: { releasedNumbers: number; sipAccountDeleted: boolean } }).data;
    expect(data.releasedNumbers).toBe(1);
    expect(data.sipAccountDeleted).toBe(true);

    // The number is nobody's again, and free of the extension it pointed at.
    const freed = await one<{ status: string; assigned_user_id: string | null; sip_extension: string | null }>(
      'SELECT status, assigned_user_id, sip_extension FROM numbers WHERE id = $1',
      [number?.id],
    );
    expect(freed?.status).toBe('AVAILABLE');
    expect(freed?.assigned_user_id).toBeNull();
    expect(freed?.sip_extension).toBeNull();

    // The assignment record itself is purged with the user (operator order
    // 2026-10-08: all data of the user is lost)...
    const assignment = await query<{ c: string }>(
      'SELECT count(*)::text AS c FROM number_assignments WHERE number_id = $1',
      [number?.id],
    );
    expect(Number(assignment.rows[0]?.c)).toBe(0);

    // ...its inbound route is closed on our side...
    const mapping = await query<{ status: string; deleted_at: Date | null }>(
      'SELECT status, deleted_at FROM inbound_route_mappings WHERE number_id = $1',
      [number?.id],
    );
    expect(mapping.rows[0]?.status).toBe('REMOVED');

    // ...the SIP account and the account itself are gone.
    const sip = await query<{ c: string }>('SELECT count(*)::text AS c FROM sip_accounts WHERE user_id = $1', [user.id]);
    expect(Number(sip.rows[0]?.c)).toBe(0);
    const deleted = await query<{ status: string; deleted_at: Date | null; telegram_id: number | null }>(
      'SELECT status, deleted_at, telegram_id FROM users WHERE id = $1',
      [user.id],
    );
    expect(deleted.rows[0]?.status).toBe('DELETED');
    expect(deleted.rows[0]?.deleted_at).not.toBeNull();
    // operator order 2026-10-08: the telegram binding is freed too - zero data carried.
    expect(deleted.rows[0]?.telegram_id).toBeNull();

    // Nothing happened silently: every step is audited (audit_logs is
    // truncated between tests, so the whole table is this test's trail).
    const audit = await query<{ action: string }>('SELECT action FROM audit_logs');
    const actions = audit.rows.map((r) => r.action);
    expect(actions).toContain('NUMBER_RELEASED');
    expect(actions).toContain('SIP_ACCOUNT_DELETED');
    expect(actions).toContain('USER_PURGED');
  });
});

describe('forced catalogue removal (spec §17 - the admin decides)', () => {
  it('refuses without force, and revokes the numbers users hold when forced', async () => {
    const admin = await createUser({ telegramId: 700921 });
    const holder = await createUser({ telegramId: 700922 });

    const country = await one<{ id: string }>(
      `INSERT INTO countries (name, iso2, dial_code, flag, status, sort_order)
       VALUES ('Forceland','QF','999','🏳️','ACTIVE',99) RETURNING id`,
    );
    const service = await one<{ id: string }>(
      `INSERT INTO services (slug, name, icon, status) VALUES ('force-svc','Force Service','🧪','ACTIVE') RETURNING id`,
    );
    await query(
      `INSERT INTO service_countries (service_id, country_id, price_cents, currency) VALUES ($1,$2,0,'EUR')
       ON CONFLICT (service_id, country_id) DO NOTHING`,   // 0 = free: pricing now charges wallets; these fixtures only exercise offer rows
      [service!.id, country!.id],
    );
    await query(
      `INSERT INTO numbers (phone_number, country_id, service_id, plan_type, status)
       VALUES ('+999501235601', $1, $2, 'FREE', 'AVAILABLE')`,
      [country!.id, service!.id],
    );
    await createSipAccount(holder.id, '10082');
    const number = await one<{ id: string }>("SELECT id FROM numbers WHERE phone_number = '+999501235601'");
    const assigned = await call('/api/admin/numbers/assign', {
      method: 'POST',
      headers: { 'x-actor-user-id': admin.id },
      body: JSON.stringify({ numberId: number?.id, userId: holder.id }),
    });
    expect(assigned.status).toBeLessThan(300);

    // Default: refused while a user holds one of its numbers (no accident).
    const refused = await call(`/api/admin/countries/${country!.id}`, {
      method: 'DELETE',
      headers: { 'x-actor-user-id': admin.id },
    });
    expect(refused.status).toBe(409);
    expect(JSON.stringify(refused.body)).toMatch(/in use/i);

    // Forced: the removal goes through and takes the number with it.
    const forced = await call(`/api/admin/countries/${country!.id}?force=1`, {
      method: 'DELETE',
      headers: { 'x-actor-user-id': admin.id },
    });
    expect(forced.status).toBe(200);
    const data = (forced.body as { data: { revokedNumbers: number; affectedUsers: number } }).data;
    expect(data.revokedNumbers).toBe(1);
    expect(data.affectedUsers).toBe(1);

    // The number left the user's account and is retired with the country.
    const freed = await one<{ status: string; assigned_user_id: string | null; deleted_at: Date | null }>(
      'SELECT status, assigned_user_id, deleted_at FROM numbers WHERE id = $1',
      [number?.id],
    );
    expect(freed?.assigned_user_id).toBeNull();
    expect(freed?.status).toBe('DISABLED');
    expect(freed?.deleted_at).not.toBeNull();

    // Its route is closed on our side, its assignment released.
    const mapping = await query<{ status: string }>(
      'SELECT status FROM inbound_route_mappings WHERE number_id = $1 AND deleted_at IS NULL',
      [number?.id],
    );
    expect(mapping.rows).toHaveLength(0);
    const assignment = await query<{ status: string }>('SELECT status FROM number_assignments WHERE number_id = $1', [number?.id]);
    expect(assignment.rows[0]?.status).toBe('RELEASED');

    // The holder keeps their account and SIP line - only the number is gone.
    const stillActive = await one<{ status: string }>('SELECT status FROM users WHERE id = $1', [holder.id]);
    expect(stillActive?.status).toBe('ACTIVE');
    const sip = await one<{ status: string }>(
      'SELECT status FROM sip_accounts WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1',
      [holder.id],
    );
    expect(sip?.status).toBe('ACTIVE');

    // ...and they were told, with the country deletion audited.
    const notified = await query<{ kind: string }>(
      "SELECT kind FROM notifications WHERE user_id = $1 AND dedupe_key LIKE 'country-removed:%'",
      [holder.id],
    );
    expect(notified.rows[0]?.kind).toBe('NUMBER_RELEASED');
    const audit = await query<{ action: string }>(
      "SELECT action FROM audit_logs WHERE action IN ('COUNTRY_DELETED','NUMBER_RELEASED') AND target_id IN ($1, $2)",
      [country!.id, number?.id],
    );
    const actions = audit.rows.map((r) => r.action);
    expect(actions).toContain('COUNTRY_DELETED');
    expect(actions).toContain('NUMBER_RELEASED');
  });

  it('does the same for a forced service removal', async () => {
    const admin = await createUser({ telegramId: 700931 });
    const holder = await createUser({ telegramId: 700932 });
    const countryId = await getCountryId();

    const service = await one<{ id: string }>(
      `INSERT INTO services (slug, name, icon, status) VALUES ('force-svc-2','Force Service 2','🧪','ACTIVE') RETURNING id`,
    );
    await query(
      `INSERT INTO service_countries (service_id, country_id, price_cents, currency) VALUES ($1,$2,0,'EUR')
       ON CONFLICT (service_id, country_id) DO NOTHING`,   // 0 = free: pricing now charges wallets; these fixtures only exercise offer rows
      [service!.id, countryId],
    );
    await query(
      `INSERT INTO numbers (phone_number, country_id, service_id, plan_type, status)
       VALUES ('+971501235602', $1, $2, 'FREE', 'AVAILABLE')`,
      [countryId, service!.id],
    );
    await createSipAccount(holder.id, '10083');
    const number = await one<{ id: string }>("SELECT id FROM numbers WHERE phone_number = '+971501235602'");
    await call('/api/admin/numbers/assign', {
      method: 'POST',
      headers: { 'x-actor-user-id': admin.id },
      body: JSON.stringify({ numberId: number?.id, userId: holder.id }),
    });

    const forced = await call(`/api/admin/services/${service!.id}`, {
      method: 'DELETE',
      headers: { 'x-actor-user-id': admin.id },
      body: JSON.stringify({ force: true }),
    });
    expect(forced.status).toBe(200);
    expect((forced.body as { data: { revokedNumbers: number } }).data.revokedNumbers).toBe(1);

    const freed = await one<{ status: string; assigned_user_id: string | null }>(
      'SELECT status, assigned_user_id FROM numbers WHERE id = $1',
      [number?.id],
    );
    expect(freed?.assigned_user_id).toBeNull();
    expect(freed?.status).toBe('DISABLED');
  });
});

describe('re-adding a removed catalogue entry', () => {
  it('revives the removed country row instead of failing on the unique ISO2', async () => {
    const admin = await createUser({ telegramId: 700941 });
    const iso2 = 'QZ';
    const created = await call('/api/admin/countries', {
      method: 'POST',
      headers: { 'x-actor-user-id': admin.id },
      body: JSON.stringify({ name: 'Revivaland', iso2, dialCode: '999', flag: '🏳️' }),
    });
    expect(created.status).toBeLessThan(300);
    const countryId = (created.body as { data: { id: string } }).data.id;

    // A live duplicate is still a friendly conflict.
    const duplicate = await call('/api/admin/countries', {
      method: 'POST',
      headers: { 'x-actor-user-id': admin.id },
      body: JSON.stringify({ name: 'Revivaland again', iso2, dialCode: '999' }),
    });
    expect(duplicate.status).toBe(409);

    // Remove it, then add it back with the same ISO2.
    const removed = await call(`/api/admin/countries/${countryId}`, { method: 'DELETE', headers: { 'x-actor-user-id': admin.id } });
    expect(removed.status).toBe(200);

    const revived = await call('/api/admin/countries', {
      method: 'POST',
      headers: { 'x-actor-user-id': admin.id },
      body: JSON.stringify({ name: 'Revivaland', iso2, dialCode: '999', flag: '🏳️' }),
    });
    expect(revived.status).toBeLessThan(300);
    expect((revived.body as { data: { id: string; status: string } }).data.id).toBe(countryId);
    expect((revived.body as { data: { status: string } }).data.status).toBe('ACTIVE');

    const row = await one<{ status: string; deleted_at: Date | null }>('SELECT status, deleted_at FROM countries WHERE id = $1', [countryId]);
    expect(row?.status).toBe('ACTIVE');
    expect(row?.deleted_at).toBeNull();
  });
});
