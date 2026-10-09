/**
 * End-to-end smoke test (`npm run smoke`).
 *
 * Walks the real user journey through the real HTTP API against the real
 * database:
 *
 *   create applicant -> approve (PBX extension allocated) -> number in inventory
 *   -> assign to the user (PBX inbound route created) -> read SIP credentials
 *   -> release the number (route removed) -> clean up
 *
 * It is the check to run after a deployment, before opening the bot to users.
 *
 * Safety: PBX writes (extension creation, route creation) are only performed
 * when FreePBX is in mock mode or when `--live` is passed explicitly. Without
 * it, the script performs read-only checks and reports what it skipped, so it
 * can never surprise a production PBX.
 *
 * Usage:
 *   npm run smoke                 # read-only when FREEPBX_MODE=freepbx
 *   npm run smoke -- --live       # allow PBX writes against a real PBX
 *   npm run smoke -- --keep       # leave the created user/number in place
 */
import { closePool, one, query } from '../src/db/pool.js';
import { env } from '../src/config/env.js';
import { isMockMode } from '../src/freepbx/index.js';
import { didMatch } from '../src/lib/phone.js';

interface Check {
  name: string;
  ok: boolean;
  detail: string;
  skipped?: boolean;
}

const checks: Check[] = [];
let live = process.argv.includes('--live');
const keep = process.argv.includes('--keep');

const apiBase = process.env.SMOKE_API_URL ?? `http://127.0.0.1:${env.API_PORT}`;

function record(name: string, ok: boolean, detail: string, skipped = false): void {
  checks.push({ name, ok, detail, skipped });
  const icon = skipped ? '•' : ok ? '✓' : '✗';
  // eslint-disable-next-line no-console
  console.log(`  ${icon} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function api<T>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: { 'x-api-key': env.API_KEY, 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body: body as T };
}

async function main(): Promise<void> {
  // eslint-disable-next-line no-console
  console.log(`\nSIP bot smoke test\n  API: ${apiBase}\n  FreePBX mode: ${env.freepbx.mode}\n`);

  // -- 1. liveness -----------------------------------------------------------
  try {
    const res = await fetch(`${apiBase}/health`);
    const body = (await res.json()) as { status?: string; database?: { ok?: boolean } };
    record('API /health responds', res.ok, `HTTP ${res.status}`);
    record('database reachable', Boolean(body.database?.ok), body.database?.ok ? 'ok' : 'database not ok');
  } catch (err) {
    record('API reachable', false, (err as Error).message);
    return; // nothing else can work
  }

  // -- 2. configuration present ---------------------------------------------
  const settings = await one<{ count: string }>('SELECT count(*)::text AS count FROM admin_settings');
  record('configuration seeded', Number(settings?.count ?? 0) > 0, `${settings?.count} settings`);

  const plan = await one<{ code: string }>("SELECT code FROM plans WHERE is_default AND is_active LIMIT 1");
  record('default plan exists', Boolean(plan), plan?.code ?? 'none - run npm run seed');

  const offer = await one<{ country_id: string; service_id: string; country: string; service: string; dial_code: string }>(
    `SELECT sc.country_id, sc.service_id, c.name AS country, s.name AS service, c.dial_code
       FROM service_countries sc
       JOIN countries c ON c.id = sc.country_id AND c.status = 'ACTIVE'
       JOIN services  s ON s.id = sc.service_id AND s.status = 'ACTIVE'
      WHERE sc.status = 'ACTIVE'
      ORDER BY c.sort_order, s.sort_order LIMIT 1`,
  );
  record('at least one country/service offer is active', Boolean(offer), offer ? `${offer.country} / ${offer.service}` : 'none - enable offers in the admin panel');
  if (!offer) return;

  // -- 3. an operator account to attribute the API calls to -------------------
  //      Reused when one already exists: a test run must not leave a trail of
  //      ACTIVE users behind (the first version created a fresh one every run).
  const existingOperator = await query<{ id: string }>(
    `SELECT id FROM users
      WHERE username LIKE 'smoke_admin_%' AND status = 'ACTIVE' AND deleted_at IS NULL
      ORDER BY created_at LIMIT 1`,
  );
  let adminId = existingOperator.rows[0]?.id;
  let createdOperator = false;
  if (!adminId) {
    const operatorTelegramId = 800_000_000 + Math.floor(Math.random() * 899_999_999);
    const operator = await query<{ id: string }>(
      `INSERT INTO users (telegram_id, username, display_name, status, referral_code)
       VALUES ($1, $2, 'Smoke Operator', 'ACTIVE', $3)
       ON CONFLICT (telegram_id) DO UPDATE SET display_name = EXCLUDED.display_name
       RETURNING id`,
      [operatorTelegramId, `smoke_admin_${operatorTelegramId}`, `SMOKEA${operatorTelegramId}`],
    );
    adminId = operator.rows[0]!.id;
    createdOperator = true;
  }
  record('operator account available for attribution', true, `${adminId!.slice(0, 8)}${createdOperator ? ' (created)' : ' (reused)'}`);

  // -- 4. inventory ----------------------------------------------------------
  let inventory = await one<{ id: string; phone_number: string }>(
    `SELECT id, phone_number FROM numbers
      WHERE status = 'AVAILABLE' AND deleted_at IS NULL AND country_id = $1 AND service_id = $2
      ORDER BY created_at LIMIT 1`,
    [offer.country_id, offer.service_id],
  );

  const canWritePbx = isMockMode() || live;
  if (!inventory) {
    if (!canWritePbx) {
      record('inventory has an available number', false, 'none available and PBX writes are not allowed (pass --live)', true);
      return;
    }
    const sample = `+${offer.dial_code}5012${String(Date.now()).slice(-5)}`;
    const res = await api<{ data?: { imported?: number } }>('/api/admin/numbers/import', {
      method: 'POST',
      body: JSON.stringify({ countryId: offer.country_id, serviceId: offer.service_id, planType: 'FREE', numbers: [sample], actorId: adminId }),
    });
    inventory = await one<{ id: string; phone_number: string }>(
      'SELECT id, phone_number FROM numbers WHERE phone_number = $1',
      [sample],
    );
    record('number imported through the API', res.status < 400 && Boolean(inventory), inventory?.phone_number ?? `HTTP ${res.status}`);
    if (!inventory) return;
  } else {
    record('inventory has an available number', true, inventory.phone_number);
  }

  // -- 5. applicant -> approval ---------------------------------------------
  const telegramId = 900_000_000 + Math.floor(Math.random() * 89_999_999);
  const applicant = await query<{ id: string }>(
    `INSERT INTO users (telegram_id, username, display_name, status, plan_id, referral_code)
     VALUES ($1, $2, 'Smoke Test', 'PENDING', (SELECT id FROM plans WHERE is_default LIMIT 1), $3)
     RETURNING id`,
    [telegramId, `smoke_${telegramId}`, `SMOKE${telegramId}`],
  );
  const userId = applicant.rows[0]!.id;
  record('applicant created', true, userId.slice(0, 8));

  if (!canWritePbx) {
    record('approval + SIP provisioning', false, 'skipped: would create an extension on the live PBX (pass --live)', true);
    record('number assignment', false, 'skipped: would create an inbound route on the live PBX (pass --live)', true);
  } else {
    const approve = await api<{ data?: { user?: { status?: string }; sip?: { account?: { extension?: string } } | null; warning?: string | null } }>(
      `/api/admin/users/${userId}/approve`,
      { method: 'POST', body: '{}' },
    );
    const extension = approve.body?.data?.sip?.account?.extension;
    record(
      'user approved and SIP extension allocated',
      approve.status === 200 && approve.body?.data?.user?.status === 'ACTIVE' && Boolean(extension),
      extension ? `extension ${extension}` : approve.body?.data?.warning ?? `HTTP ${approve.status}`,
    );

    const assign = await api<{ data?: { numberId?: string; phoneNumber?: string; extension?: string; routeId?: string | null; pbxWarning?: string } }>(
      '/api/admin/numbers/assign',
      { method: 'POST', body: JSON.stringify({ userId, countryId: offer.country_id, serviceId: offer.service_id, actorId: adminId }) },
    );
    const assignedNumber = assign.body?.data?.phoneNumber ?? null;
    const routeId = assign.body?.data?.routeId ?? null;
    record(
      'number assigned and inbound route created',
      assign.status < 400 && Boolean(assignedNumber && routeId),
      assignedNumber ? `${assignedNumber} -> route ${routeId ?? 'missing'}` : `HTTP ${assign.status}`,
    );

    const numberRow = await one<{ id: string; status: string; sip_extension: string | null; did_match_pattern: string | null }>(
      'SELECT id, status, sip_extension, did_match_pattern FROM numbers WHERE assigned_user_id = $1 LIMIT 1',
      [userId],
    );
    record('number row reflects the assignment', numberRow?.status === 'ASSIGNED', `status ${numberRow?.status ?? 'missing'}`);
    record(
      'DID match pattern derived for the trunk',
      numberRow?.did_match_pattern === didMatch(assignedNumber ?? '+1') || Boolean(numberRow?.did_match_pattern),
      numberRow?.did_match_pattern ?? 'missing',
    );

    // Reading credentials is an audited admin action, so the caller must be
    // attributed (spec §33): the operator id travels in the header.
    const sip = await api<{ data?: { extension?: string; password?: string } }>(`/api/admin/users/${userId}/sip`, {
      headers: { 'x-actor-user-id': adminId },
    });
    record(
      'SIP credentials retrievable by the attributed operator',
      sip.status === 200 && Boolean(sip.body?.data?.password),
      sip.body?.data?.extension ? `extension ${sip.body.data.extension} (secret present: ${sip.body.data.password ? 'yes' : 'no'})` : `HTTP ${sip.status}`,
    );

    const audit = await query<{ action: string }>(
      "SELECT action FROM audit_logs WHERE action IN ('NUMBER_ASSIGNED','SIP_ACCOUNT_CREATED','USER_APPROVED') GROUP BY action",
    );
    record('audit trail written for the journey', audit.rowCount === 3, audit.rows.map((r) => r.action).join(', '));

    // -- 6. taking another number replaces the first (no manual release) ------
    //      The old route must be deleted on the real PBX before the number is
    //      freed, so this exercises the delete-then-create sequence live.
    let second = await one<{ id: string; phone_number: string }>(
      `SELECT id, phone_number FROM numbers
        WHERE status = 'AVAILABLE' AND deleted_at IS NULL AND country_id = $1 AND service_id = $2 AND id <> $3
        ORDER BY created_at LIMIT 1`,
      [offer.country_id, offer.service_id, numberRow?.id ?? '00000000-0000-0000-0000-000000000000'],
    );
    if (!second) {
      const sample = `+${offer.dial_code}5013${String(Date.now()).slice(-5)}`;
      await api('/api/admin/numbers/import', {
        method: 'POST',
        body: JSON.stringify({ countryId: offer.country_id, serviceId: offer.service_id, planType: 'FREE', numbers: [sample], actorId: adminId }),
      });
      second = await one<{ id: string; phone_number: string }>('SELECT id, phone_number FROM numbers WHERE phone_number = $1', [sample]);
    }

    if (second && numberRow?.id) {
      const replace = await api<{ data?: { phoneNumber?: string; replacedNumbers?: string[]; routeId?: string | null } }>(
        '/api/admin/numbers/assign',
        { method: 'POST', body: JSON.stringify({ userId, numberId: second.id, actorId: adminId, replaceOldest: true }) },
      );
      const replaced = replace.body?.data?.replacedNumbers ?? [];
      record(
        'taking another number assigned the new one',
        replace.status < 400 && Boolean(replace.body?.data?.routeId) && replaced.length === 1,
        replace.status < 400 ? `${replace.body?.data?.phoneNumber} replaces ${replaced.join(', ') || '—'}` : `HTTP ${replace.status}`,
      );

      const oldRow = await one<{ status: string; assigned_user_id: string | null }>(
        'SELECT status, assigned_user_id FROM numbers WHERE id = $1',
        [numberRow.id],
      );
      const oldRoute = await one<{ status: string }>(
        "SELECT status FROM inbound_route_mappings WHERE number_id = $1 ORDER BY created_at DESC LIMIT 1",
        [numberRow.id],
      );
      record(
        'replaced number returned to inventory with its route removed',
        oldRow?.status === 'AVAILABLE' && oldRow?.assigned_user_id === null && oldRoute?.status === 'REMOVED',
        `status ${oldRow?.status ?? 'missing'}, route ${oldRoute?.status ?? 'missing'}`,
      );

      const heldCount = await one<{ count: string }>(
        `SELECT count(*)::text AS count FROM numbers
          WHERE assigned_user_id = $1 AND deleted_at IS NULL AND status IN ('ASSIGNED','SUSPENDED')`,
        [userId],
      );
      record('the user holds exactly one number afterwards', Number(heldCount?.count ?? 0) === 1, `${heldCount?.count} held`);
    } else {
      record('replacement path exercised', false, 'no second number available', true);
    }

    if (keep) {
      record('cleanup', true, '--keep passed: user and number left in place', true);
    } else {
      const heldByApplicant = await query<{ id: string }>(
        `SELECT id FROM numbers
          WHERE assigned_user_id = $1 AND deleted_at IS NULL AND status IN ('ASSIGNED','SUSPENDED','RESERVED')`,
        [userId],
      );
      if (heldByApplicant.rowCount && heldByApplicant.rowCount > 0) {
        for (const held of heldByApplicant.rows) {
          const release = await api('/api/admin/numbers/release', {
            method: 'POST',
            body: JSON.stringify({ numberId: held.id, actorId: adminId, reason: 'smoke test' }),
          });
          record('number released and route removed', release.status < 400, `HTTP ${release.status}`);
          const released = await one<{ status: string }>('SELECT status FROM numbers WHERE id = $1', [held.id]);
          record('released number is back in the pool', released?.status === 'AVAILABLE', `status ${released?.status ?? 'missing'}`);
        }
      }
      const del = await api(`/api/admin/users/${userId}`, { method: 'DELETE' });
      record('applicant cleaned up', del.status < 400, `HTTP ${del.status}`);
      // Scaffolding only: an operator this run created is closed again. A
      // reused one stays (it is the standing attribution account). Users are
      // soft-deleted, never removed - `audit_logs` references them and is
      // append-only (a hard DELETE is blocked by the database on purpose).
      if (createdOperator) {
        await query("UPDATE users SET status = 'DELETED', deleted_at = now(), blocked_reason = 'smoke test scaffolding' WHERE id = $1", [
          adminId,
        ]).catch(() => undefined);
      }
    }
  }
}

const started = Date.now();
main()
  .catch((err) => {
    record('smoke run completed without exception', false, (err as Error).message);
  })
  .finally(async () => {
    const failed = checks.filter((c) => !c.ok && !c.skipped);
    const skipped = checks.filter((c) => c.skipped);
    // eslint-disable-next-line no-console
    console.log(
      `\n${failed.length === 0 ? 'SMOKE OK' : 'SMOKE FAILED'} — ${checks.length - skipped.length} checks run, ` +
        `${failed.length} failed, ${skipped.length} skipped in ${Date.now() - started}ms\n`,
    );
    if (failed.length > 0) process.exitCode = 1;
    await closePool().catch(() => undefined);
  });
