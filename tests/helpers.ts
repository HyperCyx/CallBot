import { one, query } from '../src/db/pool.js';
import { encryptSecret } from '../src/lib/crypto.js';
import { didMatch } from '../src/lib/phone.js';
import type { MockFreePBXClient } from '../src/freepbx/index.js';
import { getFreePBX } from '../src/freepbx/index.js';

/** Test factories. Everything is created through SQL so services stay honest. */

export async function createUser(overrides: Partial<{ telegramId: number; username: string; status: string; planCode: string }> = {}) {
  const telegramId = overrides.telegramId ?? Math.floor(Math.random() * 1_000_000) + 100_000;
  const username = overrides.username ?? `user${telegramId}`;
  const status = overrides.status ?? 'ACTIVE';
  const planCode = overrides.planCode ?? 'free';

  const plan = await one<{ id: string }>('SELECT id FROM plans WHERE code = $1', [planCode]);
  const row = await one<{ id: string; telegram_id: number }>(
    `INSERT INTO users (telegram_id, username, display_name, status, plan_id, referral_code, approved_at, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,now(), now() + interval '30 days')
     RETURNING id, telegram_id`,
    [telegramId, username, username, status, plan?.id ?? null, `REF${telegramId}`.slice(0, 10).toUpperCase()],
  );
  return row!;
}

export async function createSipAccount(userId: string, extension?: string) {
  const ext = extension ?? String(10_000 + Math.floor(Math.random() * 90));
  const endpoint = { server: 'pbx.test', port: 5060, transport: 'UDP', domain: 'pbx.test' };
  const row = await one<{ id: string; extension: string }>(
    `INSERT INTO sip_accounts (user_id, extension, technology, sip_server, sip_port, sip_transport, sip_domain,
                               display_name, password_encrypted, status)
     VALUES ($1,$2,'pjsip',$3,$4,$5,$6,'test',$7,'ACTIVE')
     ON CONFLICT (extension) WHERE deleted_at IS NULL DO UPDATE SET user_id = EXCLUDED.user_id
     RETURNING id, extension`,
    [userId, ext, endpoint.server, endpoint.port, endpoint.transport, endpoint.domain, encryptSecret('TestPassword123')],
  );
  // Also create it on the (mock) PBX so the two sides agree, like the real flow.
  const pbx = getFreePBX();
  await pbx
    .createExtension({ extensionId: ext, name: 'test', email: 'test@invalid.local' }, { sipPassword: 'TestPassword123' })
    .catch(() => undefined);
  return row!;
}

export async function getCountryId(iso2 = 'AE'): Promise<string> {
  const row = await one<{ id: string }>('SELECT id FROM countries WHERE iso2 = $1', [iso2]);
  return row!.id;
}

export async function getServiceId(slug = 'whatsapp'): Promise<string> {
  const row = await one<{ id: string }>('SELECT id FROM services WHERE slug = $1', [slug]);
  return row!.id;
}

export async function addNumbersToInventory(opts: {
  count: number;
  countryId?: string;
  serviceId?: string;
  planType?: 'FREE' | 'PREMIUM';
  startFrom?: number;
}): Promise<string[]> {
  const countryId = opts.countryId ?? (await getCountryId());
  const serviceId = opts.serviceId ?? (await getServiceId());
  const planType = opts.planType ?? 'FREE';
  const base = opts.startFrom ?? 50_000_000;
  const ids: string[] = [];

  for (let i = 0; i < opts.count; i += 1) {
    const number = `+9715${String(base + i).padStart(8, '0')}`;
    const row = await one<{ id: string }>(
      `INSERT INTO numbers (phone_number, did_match_pattern, country_id, service_id, status, plan_type)
       VALUES ($1,$2,$3,$4,'AVAILABLE',$5) RETURNING id`,
      [number, didMatch(number), countryId, serviceId, planType],
    );
    ids.push(row!.id);
  }
  return ids;
}

export function mockPbx(): MockFreePBXClient {
  return getFreePBX() as MockFreePBXClient;
}

export async function countActiveAssignments(numberId: string): Promise<number> {
  const res = await query<{ count: string }>(
    'SELECT count(*)::text AS count FROM number_assignments WHERE number_id = $1 AND released_at IS NULL',
    [numberId],
  );
  return Number(res.rows[0]?.count ?? 0);
}

export async function getNumberRow(numberId: string) {
  return one<{ status: string; assigned_user_id: string | null; phone_number: string; sip_extension: string | null }>(
    'SELECT status, assigned_user_id, phone_number, sip_extension FROM numbers WHERE id = $1',
    [numberId],
  );
}

export async function getRouteForNumber(numberId: string) {
  return one<{
    freepbx_route_id: string | null;
    destination: string;
    destination_extension: string | null;
    status: string;
    did_match_pattern: string;
    drift_state: string | null;
    deleted_at: Date | null;
  }>(
    `SELECT freepbx_route_id, destination, destination_extension, status, did_match_pattern, drift_state, deleted_at
       FROM inbound_route_mappings
      WHERE number_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [numberId],
  );
}

export async function auditActions(): Promise<string[]> {
  const res = await query<{ action: string }>('SELECT action FROM audit_logs ORDER BY id');
  return res.rows.map((r) => r.action);
}
