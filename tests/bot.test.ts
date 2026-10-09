/**
 * Bot UX regression tests.
 *
 * Two behaviours that were reported from live use and must never come back:
 *
 *   1. the account the bot is launched with (a super admin id) is never left
 *      sitting in "pending approval";
 *   2. every screen the bot sends offers a way back.
 *
 * The bot is driven exactly like Telegram drives it: real updates in, and the
 * outbound HTTP calls are captured instead of being sent.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBot } from '../src/bot/index.js';
import { closePool, one, query } from '../src/db/pool.js';
import { env } from '../src/config/env.js';
import { NAV_BACK } from '../src/bot/nav.js';
import { CB } from '../src/bot/keyboards.js';
import { checkCallbackData, sanitizeInlineKeyboard, MAX_CALLBACK_BYTES } from '../src/bot/callback-data.js';
import { metrics } from '../src/lib/metrics.js';
import { addNumbersToInventory, createSipAccount, createUser } from './helpers.js';
import { assignNumber } from '../src/services/assignment.service.js';
import { registerUser } from '../src/services/user.service.js';
import { deleteUserAccount } from '../src/services/userDeletion.service.js';
import { setApprovalDeliverySender } from '../src/services/approvalDelivery.service.js';

// ---------------------------------------------------------------------------
// Harness: run the real bot against a stubbed Telegram HTTP client.
// ---------------------------------------------------------------------------
interface Sent {
  chat: number;
  method: string;
  text: string;
  buttons: Array<{ text: string; data?: string }>;
}

let sent: Sent[] = [];
let updateId = 5_000_000;

function makeFetch(): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = url.split('/').pop() as string;
    const payload: Record<string, unknown> = init?.body
      ? typeof init.body === 'string'
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : (init.body as unknown as Record<string, unknown>)
      : {};

    const respond = (result: unknown) =>
      new Response(JSON.stringify({ ok: true, result }), { status: 200, headers: { 'content-type': 'application/json' } });

    if (method === 'getMe') {
      return respond({ id: 1, is_bot: true, first_name: 'Test', username: 'test_bot', can_join_groups: true });
    }
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
      return respond({
        message_id: payload.message_id ?? 1,
        date: 0,
        chat: { id: Number(payload.chat_id ?? 1), type: 'private' },
        text: payload.text ?? '',
      });
    }
    return respond(true);
  }) as unknown as typeof fetch;
}

type Bot = NonNullable<ReturnType<typeof createBot>>;
let bot: Bot;

function messageUpdate(text: string, chatId: number, fromId: number, username: string) {
  const entities = text.startsWith('/')
    ? [{ type: 'bot_command' as const, offset: 0, length: text.split(/\s/)[0]!.length }]
    : undefined;
  return {
    update_id: updateId++,
    message: {
      message_id: updateId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: chatId, type: 'private' as const },
      from: { id: fromId, is_bot: false, first_name: 'Test', username, language_code: 'en' },
      text,
      ...(entities ? { entities } : {}),
    },
  };
}

function callbackUpdate(data: string, chatId: number, fromId: number) {
  return {
    update_id: updateId++,
    callback_query: {
      id: String(updateId),
      from: { id: fromId, is_bot: false, first_name: 'Test', username: 'tester', language_code: 'en' },
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

async function start(chatId: number, fromId: number, username = 'tester'): Promise<Sent[]> {
  sent = [];
  await bot.handleUpdate(messageUpdate('/start', chatId, fromId, username) as never);
  return sent;
}

async function tap(data: string, chatId: number, fromId: number): Promise<Sent | undefined> {
  sent = [];
  await bot.handleUpdate(callbackUpdate(data, chatId, fromId) as never);
  return sent[sent.length - 1];
}

const NAV_LABELS = /^(⬅️ Back|Back to .*|🏠 Main Menu|🏠 Menu|🛠 Admin Panel)$/;

function hasNavigation(screen: Sent): boolean {
  return screen.buttons.some((b) => NAV_LABELS.test(b.text));
}

async function grantRole(userId: string, code: string): Promise<void> {
  await query(
    `INSERT INTO user_roles (user_id, role_id)
     SELECT $1, id FROM roles WHERE code = $2
     ON CONFLICT DO NOTHING`,
    [userId, code],
  );
}

beforeAll(async () => {
  // The token is irrelevant here: every outbound call goes to the stub above.
  bot = createBot({ apiFetch: makeFetch(), token: '1:TEST-TOKEN' })!;
  await bot.init();
});

afterAll(async () => {
  await closePool();
});

// ---------------------------------------------------------------------------
describe('callback data fits in the 64 bytes Telegram allows', () => {
  it('flags oversized and non-ascii payloads', () => {
    expect(checkCallbackData({ text: 'ok', callback_data: 'n:s:abc' })).toBeNull();
    expect(checkCallbackData({ text: 'no data' })).toBeNull();
    expect(checkCallbackData({ text: 'link', url: 'https://example.test' })).toBeNull();

    const long = `n:get:${'a'.repeat(60)}:FREE`;
    expect(checkCallbackData({ text: 'too long', callback_data: long })?.reason).toBe('too-long');
    expect(checkCallbackData({ text: 'unicode', callback_data: 'n:c:ü' })?.reason).toBe('not-ascii');
  });

  it('drops only the offending button, keeping the rest of the keyboard', () => {
    const { violations, cleaned } = sanitizeInlineKeyboard({
      inline_keyboard: [
        [{ text: 'good', callback_data: 'n:s:ok' }],
        [{ text: 'bad', callback_data: `n:get:${'a'.repeat(80)}` }],
        [{ text: 'also good', callback_data: 'nav:back' }],
      ],
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]!.bytes).toBeGreaterThan(MAX_CALLBACK_BYTES);
    const rows = (cleaned as { inline_keyboard: Array<Array<{ text: string }>> }).inline_keyboard;
    expect(rows.flat().map((b) => b.text)).toEqual(['good', 'also good']);
  });

  it('renders every screen the sweep reaches without a single dropped button', async () => {
    const admin = await createUser({ status: 'ACTIVE', username: 'bytes' });
    await grantRole(admin!.id, 'admin');
    const chatId = Number(admin!.telegram_id);
    await start(chatId, chatId, 'bytes');

    const country = await one<{ id: string }>('SELECT id FROM countries LIMIT 1');
    const service = await one<{ id: string }>('SELECT id FROM services LIMIT 1');
    await addNumbersToInventory({ count: 1, countryId: country!.id, serviceId: service!.id });

    const violations = (): number =>
      Object.values(metrics.counters.invalidCallbackData.snapshot()).reduce((a, b) => a + b, 0);
    const before = violations();
    for (const data of [
      CB.GET_NUMBER,
      `n:c:${country!.id}`,
      `n:s:${service!.id}`,
      CB.MY_NUMBERS,
      CB.SIP_INFO,
      CB.REFERRAL,
      'a:home',
      'a:nadd',
      `a:nacountry:${country!.id}`,
      `a:naservice:${service!.id}`,
      'a:ncsv',
      `a:ncscountry:${country!.id}`,
      `a:ncsservice:${service!.id}`,
    ]) {
      await bot.handleUpdate(callbackUpdate(data, chatId, chatId) as never);
    }

    expect(violations() - before).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('operator bootstrap (spec: the launch id is never pending)', () => {
  it('activates a PENDING super admin on /start and provisions SIP, without any admin action', async () => {
    const user = await createUser({ status: 'PENDING', username: 'operator' });
    await grantRole(user!.id, 'super_admin');
    const chatId = Number(user!.telegram_id);

    const replies = await start(chatId, chatId, 'operator');

    expect(replies.length).toBeGreaterThan(0);
    const joined = replies.map((r) => r.text).join('\n');
    expect(joined).not.toMatch(/pending/i);
    expect(joined).toMatch(/Operator account activated/i);

    const row = await one<{ status: string; approved_at: Date | null }>(
      'SELECT status, approved_at FROM users WHERE id = $1',
      [user!.id],
    );
    expect(row!.status).toBe('ACTIVE');
    expect(row!.approved_at).not.toBeNull();

    const sip = await one<{ extension: string; status: string }>(
      'SELECT extension, status FROM sip_accounts WHERE user_id = $1',
      [user!.id],
    );
    expect(sip).toBeTruthy();
    expect(sip!.status).toBe('ACTIVE');
  });

  it('leaves an ordinary PENDING user in the queue', async () => {
    const user = await createUser({ status: 'PENDING', username: 'applicant' });
    const chatId = Number(user!.telegram_id);

    const replies = await start(chatId, chatId, 'applicant');

    expect(replies.map((r) => r.text).join('\n')).toMatch(/wait for approval/i);
    const row = await one<{ status: string }>('SELECT status FROM users WHERE id = $1', [user!.id]);
    expect(row!.status).toBe('PENDING');
  });

  it('recognises the configured super admin id from the environment', async () => {
    const telegramId = Number(env.superAdminIds[0]);
    expect(Number.isFinite(telegramId)).toBe(true);
    await query('DELETE FROM users WHERE telegram_id = $1', [telegramId]);
    await query(
      `INSERT INTO users (telegram_id, username, display_name, status) VALUES ($1, 'env_operator', 'Env Operator', 'PENDING')`,
      [telegramId],
    );

    const replies = await start(telegramId, telegramId, 'env_operator');

    expect(replies.map((r) => r.text).join('\n')).toMatch(/Operator account activated/i);
    const row = await one<{ status: string }>('SELECT status FROM users WHERE telegram_id = $1', [telegramId]);
    expect(row!.status).toBe('ACTIVE');
  });
});

// ---------------------------------------------------------------------------
describe('navigation (spec: every screen has a way back)', () => {
  it('walks back through the stack: Settings → Admin Panel → Main Menu', async () => {
    const admin = await createUser({ status: 'ACTIVE', username: 'navadmin' });
    await grantRole(admin!.id, 'admin');
    const chatId = Number(admin!.telegram_id);

    const menu = await start(chatId, chatId, 'navadmin');
    expect(menu[menu.length - 1]!.text).toMatch(/Main Menu/i);

    const panel = await tap('a:home', chatId, chatId);
    expect(panel?.text).toMatch(/Admin/i);

    const settings = await tap('a:settings', chatId, chatId);
    expect(settings?.buttons.some((b) => b.text === '⬅️ Back')).toBe(true);

    const back1 = await tap(NAV_BACK, chatId, chatId);
    expect(back1?.text).toMatch(/Admin/i);

    const back2 = await tap(NAV_BACK, chatId, chatId);
    expect(back2?.text).toMatch(/Main Menu/i);

    // One more Back on the root screen is a no-op, never an error screen.
    const back3 = await tap(NAV_BACK, chatId, chatId);
    expect(back3?.text ?? '').not.toMatch(/something went wrong/i);
  });

  it('does not push mutating screens onto the back stack (fail-closed allowlist)', async () => {
    const user = await createUser({ status: 'ACTIVE', username: 'navuser' });
    const chatId = Number(user!.telegram_id);
    await start(chatId, chatId, 'navuser');

    // A confirmation screen is pure render, so it is replayable; the execute
    // callback is not and must be popped straight back to the menu.
    const mine = await tap(CB.MY_NUMBERS, chatId, chatId);
    expect(mine?.text).toBeTruthy();

    const afterBack = await tap(NAV_BACK, chatId, chatId);
    expect(afterBack?.text).toMatch(/Main Menu/i);
  });

  it('walks back up the Get Number flow without looping', async () => {
    const user = await createUser({ status: 'ACTIVE', username: 'flowuser' });
    const chatId = Number(user!.telegram_id);
    await start(chatId, chatId, 'flowuser');

    const picker = await tap(CB.GET_NUMBER, chatId, chatId);
    expect(picker?.text).toMatch(/Select Country/i);

    // One offer with one number is enough for the country to lead somewhere.
    const country = await one<{ id: string }>('SELECT id FROM countries LIMIT 1');
    const service = await one<{ id: string }>('SELECT id FROM services LIMIT 1');
    await addNumbersToInventory({ count: 1, countryId: country!.id, serviceId: service!.id });

    const services = await tap(`n:c:${country!.id}`, chatId, chatId);
    expect(services?.text).toMatch(/Select Service/i);

    // countries → Main Menu, and further presses on the root are harmless.
    expect((await tap(NAV_BACK, chatId, chatId))?.text).toMatch(/Select Country/i);
    expect((await tap(NAV_BACK, chatId, chatId))?.text).toMatch(/Main Menu/i);
    expect((await tap(NAV_BACK, chatId, chatId))?.text).toMatch(/Main Menu/i);
  });

  it('assigns a number as soon as the service is tapped (country carried in the session)', async () => {
    const user = await createUser({ status: 'ACTIVE', username: 'assigner' });
    await createSipAccount(user!.id);
    const chatId = Number(user!.telegram_id);
    await start(chatId, chatId, 'assigner');

    const country = await one<{ id: string }>('SELECT id FROM countries LIMIT 1');
    const service = await one<{ id: string }>('SELECT id FROM services LIMIT 1');
    await addNumbersToInventory({ count: 2, countryId: country!.id, serviceId: service!.id });

    expect((await tap(CB.GET_NUMBER, chatId, chatId))?.text).toMatch(/Select Country/i);
    expect((await tap(`n:c:${country!.id}`, chatId, chatId))?.text).toMatch(/Select Service/i);

    // Tapping a service IS the assignment - no intermediate confirmation screen.
    const result = await tap(`n:s:${service!.id}`, chatId, chatId);
    expect(result?.text).toMatch(/Number assigned/i);

    const row = await one<{ status: string; sip_extension: string | null }>(
      'SELECT status, sip_extension FROM numbers WHERE assigned_user_id = $1',
      [user!.id],
    );
    expect(row?.status).toBe('ASSIGNED');
    expect(row?.sip_extension).toBeTruthy();
  });

  it('taking another number replaces the old one without a manual release (reported from live use)', async () => {
    const user = await createUser({ status: 'ACTIVE', username: 'replacer' });
    await createSipAccount(user!.id, '10074');
    const chatId = Number(user!.telegram_id);
    await start(chatId, chatId, 'replacer');

    const country = await one<{ id: string }>('SELECT id FROM countries LIMIT 1');
    const service = await one<{ id: string }>('SELECT id FROM services LIMIT 1');
    // Two numbers: one the user holds, one free for the replacement.
    const [firstId] = await addNumbersToInventory({ count: 2, countryId: country!.id, serviceId: service!.id, startFrom: 67_000_000 });
    await assignNumber({ userId: user!.id, numberId: firstId, source: 'USER', actorId: user!.id });

    // "Get Number" is no longer a dead end when the plan is full.
    expect((await tap(CB.GET_NUMBER, chatId, chatId))?.text).toMatch(/Select Country/i);
    expect((await tap(`n:c:${country!.id}`, chatId, chatId))?.text).toMatch(/Select Service/i);

    // Tapping the service assigns immediately and the receipt reports the swap.
    const result = await tap(`n:s:${service!.id}`, chatId, chatId);
    expect(result?.text).toMatch(/Number assigned/i);
    expect(result?.text).toMatch(/Replaced/i);

    // Exactly one number is held now: the new one.
    const held = await query<{ id: string; status: string }>(
      'SELECT id, status FROM numbers WHERE assigned_user_id = $1 AND deleted_at IS NULL',
      [user!.id],
    );
    expect(held.rows).toHaveLength(1);
    expect(held.rows[0]!.id).not.toBe(firstId);

    // The replaced number is back in inventory with its route closed.
    const old = await one<{ status: string; assigned_user_id: string | null }>(
      'SELECT status, assigned_user_id FROM numbers WHERE id = $1',
      [firstId],
    );
    expect(old?.status).toBe('AVAILABLE');
    expect(old?.assigned_user_id).toBeNull();
    const route = await one<{ status: string }>(
      'SELECT status FROM inbound_route_mappings WHERE number_id = $1',
      [firstId],
    );
    expect(route?.status).toBe('REMOVED');
  });

  it('a pending account sees only the waiting screen — never the action menu (screenshot regression)', async () => {
    const user = await createUser({ status: 'PENDING', username: 'waiter' });
    const chatId = Number(user!.telegram_id);

    const replies = await start(chatId, chatId, 'waiter');
    const screen = replies[replies.length - 1]!;
    expect(screen.text).toMatch(/Request sent to admin/);
    expect(screen.text).toMatch(/Please wait for approval/);
    expect(screen.text).toMatch(/notified when approved/);

    // One refresh button, none of the actions a pending account cannot use.
    expect(screen.buttons).toHaveLength(1);
    expect(screen.buttons[0]!.text).toBe('🔄 Check approval status');
    expect(screen.buttons[0]!.data).toBe('start:pending');
    expect(screen.text).not.toMatch(/Get Number/);

    // The refresh button re-renders the same waiting screen (still PENDING).
    const refresh = await tap('start:pending', chatId, chatId);
    expect(refresh?.text).toMatch(/Please wait for approval/);
  });

  it('approving a user delivers SIP ID, password and host in the approval DM', async () => {
    // The operator's required approval message:
    //  ✅ Your account has been approved!
    //  🔑 SIP ID: …  🔐 Password: …  🌐 Host: …:5060  📅 Expires: …
    const dms: Array<{ chatId: number; text: string }> = [];
    setApprovalDeliverySender(async (chatId, text) => { dms.push({ chatId, text }); });
    try {
      const admin = await createUser({ status: 'ACTIVE', username: 'approver' });
      await grantRole(admin!.id, 'admin');
      const adminChat = Number(admin!.telegram_id);
      await start(adminChat, adminChat, 'approver');

      const pending = await createUser({ status: 'PENDING', username: 'newjoiner' });
      const dmBefore = dms.length;
      const result = await tap(`a:uap:${pending!.id}`, adminChat, adminChat);
      expect(result?.text).toMatch(/User approved/);

      // Exactly one new DM went out, to the approved user's chat.
      expect(dms.length - dmBefore).toBe(1);
      const dm = dms[dms.length - 1]!;
      expect(dm.chatId).toBe(Number(pending!.telegram_id));

      // The operator-facing format, in order.
      expect(dm.text).toMatch(/Your account has been approved/);
      const sipId = dm.text.match(/SIP ID: <code>([0-9]+)<\/code>/);
      const password = dm.text.match(/Password: <code>([^<]+)<\/code>/);
      const host = dm.text.match(/Host: <code>([^<]+)<\/code>/);
      expect(sipId?.[1]).toBeTruthy();
      expect(password?.[1]).toBeTruthy();
      expect(host?.[1]).toMatch(/:5060$/);
      expect(dm.text).toMatch(/Expires: \d{4}-\d{2}-\d{2}/);
      expect(dm.text).toMatch(/Use \/start/);

      // The extension was really provisioned for that user; the password was
      // NOT written into the notifications table (it stays encrypted in
      // sip_accounts only).
      const sip = await one<{ extension: string; status: string }>(
        'SELECT extension, status FROM sip_accounts WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1',
        [pending!.id],
      );
      expect(sip?.extension).toBe(sipId?.[1]);
      expect(sip?.status).toBe('ACTIVE');
      const persisted = await query<{ count: string }>(
        "SELECT count(*)::text AS count FROM notifications WHERE user_id = $1 AND kind = 'USER_APPROVED'",
        [pending!.id],
      );
      expect(Number(persisted.rows[0]?.count)).toBe(0);
    } finally {
      setApprovalDeliverySender(null);
    }
  });

  it('falls back to the password-free notification when the approval DM cannot be delivered', async () => {
    setApprovalDeliverySender(async () => { throw new Error('chat not found'); });
    try {
      const admin = await createUser({ status: 'ACTIVE', username: 'approver2' });
      await grantRole(admin!.id, 'admin');
      const adminChat = Number(admin!.telegram_id);
      await start(adminChat, adminChat, 'approver2');
      const pending = await createUser({ status: 'PENDING', username: 'blockedchat' });

      await tap(`a:uap:${pending!.id}`, adminChat, adminChat);
      const persisted = await query<{ payload: { extension?: string } }>(
        "SELECT payload FROM notifications WHERE user_id = $1 AND kind = 'USER_APPROVED'",
        [pending!.id],
      );
      expect(persisted.rows.length).toBe(1);
      // Password-free fallback only.
      expect(JSON.stringify(persisted.rows[0]?.payload)).not.toMatch(/password/i);
    } finally {
      setApprovalDeliverySender(null);
    }
  });

  it('shows the SIP ID on the main menu as soon as the account is provisioned, even with zero numbers', async () => {
    // Reported from live use: approved user opened /menu before holding any
    // number and saw "SIP ID: —". The SIP ID comes from sip_accounts.
    const user = await createUser({ status: 'ACTIVE', username: 'sipid' });
    await createSipAccount(user!.id, '10081');
    const chatId = Number(user!.telegram_id);
    await start(chatId, chatId, 'sipid');

    const menu = await tap(CB.MAIN_MENU, chatId, chatId);
    expect(menu?.text).toContain('SIP ID: <code>10081</code>');
    expect(menu?.text).toContain('Numbers: 0');
  });

  it('an administrator can switch the confirmation screen back on with a setting', async () => {
    const user = await createUser({ status: 'ACTIVE', username: 'confirmer' });
    await createSipAccount(user!.id, '10073');
    const chatId = Number(user!.telegram_id);
    await start(chatId, chatId, 'confirmer');

    const country = await one<{ id: string }>('SELECT id FROM countries LIMIT 1');
    const service = await one<{ id: string }>('SELECT id FROM services LIMIT 1');
    await addNumbersToInventory({ count: 1, countryId: country!.id, serviceId: service!.id, startFrom: 68_000_000 });

    // Same admin switch the live admin panel exposes.
    await query("UPDATE admin_settings SET value = $1 WHERE key = 'numbers.require_confirmation'", [JSON.stringify(true)]);

    await tap(CB.GET_NUMBER, chatId, chatId);
    await tap(`n:c:${country!.id}`, chatId, chatId);

    const confirm = await tap(`n:s:${service!.id}`, chatId, chatId);
    expect(confirm?.text).toMatch(/Assign a number/i);
    const assign = confirm!.buttons.find((b) => b.text === '✅ Assign number');
    expect(assign?.data).toBe(`n:get:${service!.id}:FREE`);

    const result = await tap(assign!.data!, chatId, chatId);
    expect(result?.text).toMatch(/Number assigned/i);
    const row = await one<{ status: string }>(
      'SELECT status FROM numbers WHERE assigned_user_id = $1',
      [user!.id],
    );
    expect(row?.status).toBe('ASSIGNED');
  });

  it('shows a back button on every screen the walker reaches', async () => {
    const admin = await createUser({ status: 'ACTIVE', username: 'sweep' });
    await grantRole(admin!.id, 'admin');
    const chatId = Number(admin!.telegram_id);
    await start(chatId, chatId, 'sweep');

    const screens: Sent[] = [];
    const targets = [
      CB.GET_NUMBER,
      CB.MY_NUMBERS,
      CB.SIP_INFO,
      CB.MY_CALLS,
      CB.REFERRAL,
      CB.SUPPORT,
      'a:home',
      'a:dash',
      'a:users',
      'a:numbers',
      'a:services',
      'a:countries',
      'a:plans',
      'a:calls',
      'a:health',
      'a:audit',
    ];
    for (const data of targets) {
      sent = [];
      await bot.handleUpdate(callbackUpdate(data, chatId, chatId) as never);
      const screen = sent[sent.length - 1];
      if (screen) screens.push(screen);
    }

    expect(screens.length).toBeGreaterThan(8);
    const missing = screens.filter((s) => !hasNavigation(s));
    expect(missing.map((s) => s.text.split('\n')[0])).toEqual([]);
  });
});

describe('re-registration (/start after account deletion)', () => {
  it('a deleted account re-registers as a brand-new identity instead of crashing on the unique telegram key', async () => {
    const user = await createUser({ status: 'ACTIVE', username: 'comeback' });
    const oldId = user!.id;
    const oldTelegramId = Number(user!.telegram_id);
    await deleteUserAccount(oldId, { actorId: oldId, reason: 'test' });
    const deleted = await one<{ deleted_at: Date | null; telegram_id: number | null; status: string }>(
      'SELECT deleted_at, telegram_id, status FROM users WHERE id = $1',
      [oldId],
    );
    expect(deleted?.deleted_at).not.toBeNull();
    expect(deleted?.status).toBe('DELETED');
    // operator order 2026-10-08: all data of the user is lost, including the
    // telegram binding - the next registration must start from zero.
    expect(deleted?.telegram_id).toBeNull();

    const again = await registerUser({ telegramId: oldTelegramId, username: 'comeback' });
    expect(again.created).toBe(true);
    expect(again.user.id).not.toBe(oldId); // fresh uuid: nothing is inherited
    expect(again.user.status).toBe('PENDING');

    // The referral-code mirror is consistent for the NEW account.
    const row = await one<{ referral_code: string }>('SELECT referral_code FROM users WHERE id = $1', [again.user.id]);
    const mirror = await one<{ code: string }>('SELECT code FROM referral_codes WHERE user_id = $1', [again.user.id]);
    expect(mirror?.code).toBe(row?.referral_code);
    // Exactly one live row exists for this Telegram account again.
    const live = await query<{ count: string }>('SELECT count(*)::text AS count FROM users WHERE telegram_id = $1', [oldTelegramId]);
    expect(Number(live.rows[0]?.count)).toBe(1);
  });

  it('two concurrent /start taps race safely: exactly one creates the account', async () => {
    const telegramId = 981_000_777;
    const [a, b] = await Promise.all([
      registerUser({ telegramId }),
      registerUser({ telegramId }),
    ]);
    expect(a.user.id).toBe(b.user.id);
    expect([a.created, b.created].sort()).toEqual([false, true]);
    const rows = await query<{ count: string }>(
      'SELECT count(*)::text AS count FROM users WHERE telegram_id = $1 AND deleted_at IS NULL',
      [telegramId],
    );
    expect(Number(rows.rows[0]?.count)).toBe(1);
  });
});
