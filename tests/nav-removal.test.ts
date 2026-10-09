/**
 * Navigation regression tests for removals (reported from live use:
 * "Admin is clicking back after removing any country but nothing is happening").
 *
 * The rule these tests defend: after *any* destructive admin action, pressing
 * Back must always render a screen - never nothing - and a screen describing
 * something that no longer exists must not stay reachable in the nav stack.
 *
 * The bot is driven exactly like Telegram drives it: real updates in, outbound
 * HTTP calls captured by a stub.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBot } from '../src/bot/index.js';
import { closePool, one, query } from '../src/db/pool.js';
import { NAV_BACK } from '../src/bot/nav.js';
import { assignNumber } from '../src/services/assignment.service.js';
import { addNumbersToInventory, createSipAccount, createUser } from './helpers.js';

// Fixtures live in the range reset-demo.ts already cleans up.
const FIXTURE_ID_BASE = 555_000_000;

interface Sent {
  chat: number;
  method: string;
  text: string;
  buttons: Array<{ text: string; data?: string }>;
}

let sent: Sent[] = [];
let updateId = 7_100_000;

function makeFetch(): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const method = String(input).split('/').pop() as string;
    const payload: Record<string, unknown> = init?.body
      ? typeof init.body === 'string'
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : (init.body as unknown as Record<string, unknown>)
      : {};
    const respond = (result: unknown) =>
      new Response(JSON.stringify({ ok: true, result }), { status: 200, headers: { 'content-type': 'application/json' } });

    if (method === 'getMe') return respond({ id: 1, is_bot: true, first_name: 'Test', username: 'test_bot' });
    if (method === 'sendMessage' || method === 'editMessageText') {
      const rows =
        (payload.reply_markup as { inline_keyboard?: Array<Array<{ text: string; callback_data?: string }>> } | undefined)
          ?.inline_keyboard ?? [];
      sent.push({
        chat: Number(payload.chat_id ?? 0),
        method,
        text: String(payload.text ?? ''),
        buttons: rows.flat().map((b) => ({ text: b.text, data: b.callback_data })),
      });
      return respond({ message_id: payload.message_id ?? 1, date: 0, chat: { id: 1, type: 'private' }, text: payload.text ?? '' });
    }
    return respond(true);
  }) as unknown as typeof fetch;
}

let bot: NonNullable<ReturnType<typeof createBot>>;

function callbackUpdate(data: string, chatId: number) {
  return {
    update_id: updateId++,
    callback_query: {
      id: String(updateId),
      from: { id: chatId, is_bot: false, first_name: 'Admin', username: 'admin', language_code: 'en' },
      chat_instance: 'test',
      message: {
        message_id: 1,
        date: Math.floor(Date.now() / 1000),
        chat: { id: chatId, type: 'private' as const },
        text: 'current',
      },
      data,
    },
  };
}

function messageUpdate(text: string, chatId: number) {
  return {
    update_id: updateId++,
    message: {
      message_id: updateId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: chatId, type: 'private' as const },
      from: { id: chatId, is_bot: false, first_name: 'Admin', username: 'admin', language_code: 'en' },
      text,
      entities: [{ type: 'bot_command' as const, offset: 0, length: text.split(/\s/)[0]!.length }],
    },
  };
}

/** Taps a button and returns whatever the bot rendered (empty string = nothing). */
async function tap(data: string, chatId: number): Promise<string> {
  sent = [];
  await bot.handleUpdate(callbackUpdate(data, chatId) as never);
  const last = sent[sent.length - 1];
  return last?.text ?? '';
}

async function makeAdmin(username: string): Promise<number> {
  const telegramId = FIXTURE_ID_BASE + Math.floor(Math.random() * 900_000);
  const user = await createUser({ telegramId, username, status: 'ACTIVE' });
  await query(
    `INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code = 'admin' ON CONFLICT DO NOTHING`,
    [user.id],
  );
  await bot.handleUpdate(messageUpdate('/start', telegramId) as never);
  sent = [];
  return telegramId;
}

async function makeCountry(iso2: string, name: string): Promise<string> {
  const row = await one<{ id: string }>(
    `INSERT INTO countries (name, iso2, dial_code, flag, status, sort_order)
     VALUES ($1,$2,'999','🏳️','ACTIVE',99)
     ON CONFLICT (iso2) DO UPDATE SET name = EXCLUDED.name, status = 'ACTIVE', deleted_at = NULL
     RETURNING id`,
    [name, iso2],
  );
  return row!.id;
}

async function makeService(slug: string, name: string): Promise<string> {
  const row = await one<{ id: string }>(
    `INSERT INTO services (slug, name, icon, status) VALUES ($1,$2,'🧪','ACTIVE')
     ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, status = 'ACTIVE', deleted_at = NULL
     RETURNING id`,
    [slug, name],
  );
  return row!.id;
}

beforeAll(async () => {
  bot = createBot({ apiFetch: makeFetch(), token: '1:TEST-TOKEN' })!;
  await bot.init();
});

afterAll(async () => {
  // The removals above already soft-deleted the fixture catalogue rows; close
  // out anything else this file left behind so reruns stay clean.
  await query(
    `UPDATE users SET status = 'DELETED', deleted_at = now()
      WHERE telegram_id BETWEEN $1 AND $2 AND deleted_at IS NULL`,
    [FIXTURE_ID_BASE, FIXTURE_ID_BASE + 999_999],
  );
  await query(`DELETE FROM bot_sessions WHERE key LIKE '${FIXTURE_ID_BASE}%'`).catch(() => undefined);
  await closePool();
});

describe('Back after a removal always renders a screen', () => {
  it('country: Back lands on the Countries list, then on the Admin Panel', async () => {
    const chatId = await makeAdmin('navrep_country');
    const countryId = await makeCountry('ZZ', 'NavReproland');

    await tap('a:home', chatId);
    await tap('a:countries', chatId);
    await tap(`a:ctry:${countryId}`, chatId);
    await tap(`a:ctrydel:${countryId}`, chatId);
    const removed = await tap(`a:ctrydelok:${countryId}`, chatId);
    expect(removed).toMatch(/Country removed/);

    // The stack still held a:countries -> Back must render it, not nothing.
    const back1 = await tap(NAV_BACK, chatId);
    expect(back1).toMatch(/Countries/);
    const back2 = await tap(NAV_BACK, chatId);
    expect(back2.length).toBeGreaterThan(0);
    expect(back2).toMatch(/Admin Panel/);
  });

  it('service: Back lands on the Services list', async () => {
    const chatId = await makeAdmin('navrep_service');
    const serviceId = await makeService('navrep-service', 'NavRepro Service');

    await tap('a:home', chatId);
    await tap('a:services', chatId);
    await tap(`a:svc:${serviceId}`, chatId);
    await tap(`a:svcdel:${serviceId}`, chatId);
    const removed = await tap(`a:svcdelok:${serviceId}`, chatId);
    expect(removed).toMatch(/Service removed/);

    const back = await tap(NAV_BACK, chatId);
    expect(back).toMatch(/Services/);
  });

  it('number: Back lands on the inventory', async () => {
    const chatId = await makeAdmin('navrep_number');
    const countryId = await makeCountry('ZY', 'NavReproland 2');
    const serviceId = await makeService('navrep-service-2', 'NavRepro Service 2');
    const [numberId] = await addNumbersToInventory({ count: 1, countryId, serviceId, startFrom: 61_000_000 });

    await tap('a:numbers', chatId);
    await tap(`a:n:${numberId}`, chatId);
    await tap(`a:ndel:${numberId}`, chatId);
    const removed = await tap(`a:ndelok:${numberId}`, chatId);
    expect(removed).toMatch(/Number deleted/);

    const back = await tap(NAV_BACK, chatId);
    expect(back.length).toBeGreaterThan(0);
  });

  it('bulk wipe: Back never lands on a removed number', async () => {
    const chatId = await makeAdmin('navrep_wipe');
    const countryId = await makeCountry('ZX', 'NavReproland 3');
    const serviceId = await makeService('navrep-service-3', 'NavRepro Service 3');
    const [numberId] = await addNumbersToInventory({ count: 3, countryId, serviceId, startFrom: 62_000_000 });

    await tap('a:numbers', chatId);
    await tap(`a:n:${numberId}`, chatId); // detail screen that the wipe will invalidate
    await tap('a:numbers', chatId);
    await tap('a:nwipe', chatId);
    const wiped = await tap('a:nwipeok', chatId);
    expect(wiped).toMatch(/removed/);

    const back = await tap(NAV_BACK, chatId);
    expect(back.length).toBeGreaterThan(0);
  });

  it('user: deleting the account removes its assigned number, and Back still works', async () => {
    const chatId = await makeAdmin('navrep_user');
    const countryId = await makeCountry('ZW', 'NavReproland 4');
    const serviceId = await makeService('navrep-service-4', 'NavRepro Service 4');
    const victim = await createUser({ telegramId: FIXTURE_ID_BASE + 999_998, username: 'navrep_victim' });
    await createSipAccount(victim.id, '10091');
    const [numberId] = await addNumbersToInventory({ count: 1, countryId, serviceId, startFrom: 63_000_000 });
    await assignNumber({ userId: victim.id, numberId, source: 'ADMIN', actorId: victim.id });

    await tap('a:users', chatId);
    await tap(`a:u:${victim.id}`, chatId);
    await tap(`a:udel:${victim.id}`, chatId);
    const removed = await tap(`a:udelok:${victim.id}`, chatId);
    expect(removed).toMatch(/User deleted/);
    expect(removed).toMatch(/returned to inventory/);

    // The number the account held is back in inventory and points at nobody.
    const number = await one<{ status: string; assigned_user_id: string | null; sip_extension: string | null }>(
      'SELECT status, assigned_user_id, sip_extension FROM numbers WHERE id = $1',
      [numberId],
    );
    expect(number?.assigned_user_id).toBeNull();
    expect(number?.sip_extension).toBeNull();
    expect(number?.status).toBe('AVAILABLE');

    const back = await tap(NAV_BACK, chatId);
    expect(back.length).toBeGreaterThan(0);
  });

  it('a screen whose entity vanished elsewhere still comes back to life', async () => {
    // No destructive handler ran, so nothing pruned the stack: the validation
    // in the Back handler itself must skip the dead entry.
    const chatId = await makeAdmin('navrep_stale');
    const serviceId = await makeService('navrep-stale', 'NavRepro Stale');

    await tap('a:home', chatId);
    await tap('a:services', chatId);
    await tap(`a:svc:${serviceId}`, chatId);
    await query("UPDATE services SET status = 'DISABLED', deleted_at = now() WHERE id = $1", [serviceId]);

    const back = await tap(NAV_BACK, chatId);
    expect(back.length).toBeGreaterThan(0);
    expect(back).toMatch(/Services/);
  });

  it('country with a number in use: the panel warns, and removal revokes the number', async () => {
    const chatId = await makeAdmin('navrep_revoke');
    const countryId = await makeCountry('ZV', 'NavReproland 5');
    const serviceId = await makeService('navrep-service-5', 'NavRepro Service 5');
    const holder = await createUser({ telegramId: FIXTURE_ID_BASE + 999_997, username: 'navrep_holder' });
    await createSipAccount(holder.id, '10094');
    const [numberId] = await addNumbersToInventory({ count: 1, countryId, serviceId, startFrom: 64_000_000 });
    await assignNumber({ userId: holder.id, numberId, source: 'ADMIN', actorId: holder.id });

    await tap('a:home', chatId);
    await tap('a:countries', chatId);
    await tap(`a:ctry:${countryId}`, chatId);

    // The preview says what removal will take with it - it is no longer a dead end.
    const warning = await tap(`a:ctrydel:${countryId}`, chatId);
    expect(warning).toMatch(/revoke/i);
    expect(warning).toMatch(/held by <b>1<\/b> user/);

    const removed = await tap(`a:ctrydelok:${countryId}`, chatId);
    expect(removed).toMatch(/Country removed/);
    expect(removed).toMatch(/revoked from 1 user\(s\)/);

    // The number left the holder and was retired with the country...
    const number = await one<{ status: string; assigned_user_id: string | null; deleted_at: Date | null }>(
      'SELECT status, assigned_user_id, deleted_at FROM numbers WHERE id = $1',
      [numberId],
    );
    expect(number?.assigned_user_id).toBeNull();
    expect(number?.status).toBe('DISABLED');
    expect(number?.deleted_at).not.toBeNull();

    // ...the holder kept their account and was told about it...
    const holderRow = await one<{ status: string }>('SELECT status FROM users WHERE id = $1', [holder.id]);
    expect(holderRow?.status).toBe('ACTIVE');
    const notified = await query<{ count: string }>(
      "SELECT count(*)::text AS count FROM notifications WHERE user_id = $1 AND dedupe_key LIKE 'country-removed:%'",
      [holder.id],
    );
    expect(Number(notified.rows[0]?.count)).toBe(1);

    // ...and Back still renders a screen (the navigation contract).
    const back = await tap(NAV_BACK, chatId);
    expect(back.length).toBeGreaterThan(0);
  });
});
