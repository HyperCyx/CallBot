/**
 * Screen walker (development tool).
 *
 * Drives the REAL bot handlers with a stubbed Telegram API and prints, for every
 * screen a user or an admin can reach, the buttons that screen actually shows.
 *
 *   npx tsx scripts/screens.ts              # all screens
 *   npx tsx scripts/screens.ts --problems    # only screens with a navigation gap
 *
 * Why this exists: "does this screen have a back button?" is a property of what
 * the bot SENDS, not of the keyboard helpers, and hand-reading keyboards.ts
 * misses the screens that render inline keyboards on the spot. This walker feeds
 * real updates (messages and callback taps) through createBot() and records every
 * sendMessage/editMessageText payload.
 */
import { createBot } from '../src/bot/index.js';
import { closePool } from '../src/db/pool.js';
import { MockFreePBXClient, setFreePBX } from '../src/freepbx/index.js';
import { runMigrations } from '../src/db/migrate.js';
import { query } from '../src/db/pool.js';
import { findUserForTelegram } from '../src/services/user.service.js';
import { deleteSipAccount, provisionSipAccount } from '../src/services/extension.service.js';
import { env } from '../src/config/env.js';

interface Screen {
  /** How we got here, for the report. */
  path: string;
  text: string;
  buttons: string[];
}

const screens: Screen[] = [];
let currentPath: string[] = [];
/** Kept only so the wizard walk can clear the session between the two wizards. */
const ctxSessionHolder: unknown[] = [];
function ctxReset(_holder: unknown[]): void {
  /* the session persists on purpose; nothing to reset between wizard walks */
}

const problemsOnly = process.argv.includes('--problems');

// ---------------------------------------------------------------------------
// Stub Telegram API
// ---------------------------------------------------------------------------
interface SentMessage {
  text: string;
  buttons: string[];
}

const lastByChat = new Map<number, SentMessage>();
/** Every payload sent to a chat, in order - used by the scenario assertions. */
const allByChat = new Map<number, SentMessage[]>();

const TEST_CHAT = 555_000_111;
/** Telegram id of the walker's own account (see ensureWalkerAccount). */
const WALK_TG = TEST_CHAT;

function makeFetch(): typeof fetch {
  let messageId = 1000;
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = url.split('/').pop() as string;
    let payload: Record<string, unknown> = {};
    if (init?.body) {
      payload =
        typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : (init.body as unknown as Record<string, unknown>);
    }

    const respond = (result: unknown) =>
      new Response(JSON.stringify({ ok: true, result }), { status: 200, headers: { 'content-type': 'application/json' } });

    if (method === 'getMe') {
      return respond({ id: 7469743304, is_bot: true, first_name: 'Walker', username: 'walker_bot', can_join_groups: true });
    }
    if (method === 'sendMessage' || method === 'editMessageText') {
      const kb = (payload.reply_markup as { inline_keyboard?: Array<Array<{ text: string; callback_data?: string; url?: string }>> } | undefined)
        ?.inline_keyboard;
      const flat = (kb ?? []).flat().map((b) => b.text);
      const text = String(payload.text ?? '');
      // `editMessageText` edits the message the user tapped; `sendMessage`
      // starts a new one. Both are recorded so the walker sees the whole screen.
      const chatKey = Number(payload.chat_id ?? TEST_CHAT);
      lastByChat.set(chatKey, { text, buttons: flat });
      allByChat.set(chatKey, [...(allByChat.get(chatKey) ?? []), { text, buttons: flat }]);
      screens.push({ path: currentPath.join(' → ') || '(start)', text, buttons: flat });
      return respond({ message_id: payload.message_id ?? messageId++, chat: { id: TEST_CHAT, type: 'private' }, date: 0, text });
    }
    if (method === 'answerCallbackQuery' || method === 'sendChatAction' || method === 'setMyCommands' || method === 'deleteWebhook') {
      return respond(true);
    }
    if (method === 'getChatMember') {
      return respond({ status: 'member', user: { id: 1, is_bot: false, first_name: 'x' }, });
    }
    return respond(true);
  }) as unknown as typeof fetch;
}

// ---------------------------------------------------------------------------
// Update helpers
// ---------------------------------------------------------------------------
let updateId = 1;

function messageUpdate(
  text: string,
  chatId: number = TEST_CHAT,
  fromId: number = WALK_TG,
  username = 'walk_admin',
) {
  // Telegram marks commands with a bot_command entity; grammY's `bot.command()`
  // filter reads those entities, so synthetic updates must carry them too or
  // /start would silently match nothing.
  const entities = text.startsWith('/')
    ? [{ type: 'bot_command' as const, offset: 0, length: text.split(/\s/)[0]!.length }]
    : undefined;
  return {
    update_id: updateId++,
    message: {
      message_id: updateId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: chatId, type: 'private' as const },
      from: { id: fromId, is_bot: false, first_name: 'Walker', language_code: 'en', username },
      text,
      ...(entities ? { entities } : {}),
    },
  };
}

function callbackUpdate(data: string) {
  return {
    update_id: updateId++,
    callback_query: {
      id: String(updateId),
      from: { id: WALK_TG, is_bot: false, first_name: 'Walker', username: 'walk_admin', language_code: 'en' },
      chat_instance: 'walker',
      message: {
        message_id: 1,
        date: Math.floor(Date.now() / 1000),
        chat: { id: TEST_CHAT, type: 'private' as const },
        text: 'current',
      },
      data,
    },
  };
}

async function tap(bot: ReturnType<typeof createBot>, data: string, label: string): Promise<void> {
  currentPath = [...currentPath.slice(0, -1), label];
  await bot!.handleUpdate(callbackUpdate(data) as never);
}

async function type_(bot: ReturnType<typeof createBot>, text: string, chatId?: number, fromId?: number, username?: string): Promise<void> {
  await bot!.handleUpdate(messageUpdate(text, chatId, fromId, username) as never);
}

/** Finds the callback data for a button by its visible label on the last screen. */
function dataFor(last: string): string | null {
  const found = buttonIndex.find((b) => b.label.includes(last));
  return found?.data ?? null;
}

const buttonIndex: Array<{ label: string; data: string }> = [];

/** Feeds every screen we have rendered so far into the label→data index. */
function indexButtons(rows: Array<Array<{ text: string; callback_data?: string }>>): void {
  for (const row of rows) for (const b of row) if (b.callback_data) buttonIndex.push({ label: b.text, data: b.callback_data });
}

void dataFor;
void indexButtons;

// ---------------------------------------------------------------------------
// Walk
// ---------------------------------------------------------------------------
// A screen counts as navigable only if it offers one of the three escape
// hatches users actually look for - "⬅️ Back", the main menu, or the admin
// panel entry point. Loose matching (any button containing "back") hid the
// dashboard, which had no way out at all.
const NAV = /^(⬅️|🏠|🛠 Admin Panel$)/;

/**
 * Creates (or re-activates) the walker's own account: an ACTIVE admin on the
 * premium plan with a SIP account, so every admin screen and the assignment
 * flow render with real data.
 */
async function ensureWalkerAccount(): Promise<string> {
  const row = await query<{ id: string }>(
    `INSERT INTO users (telegram_id, username, display_name, status)
     VALUES ($1, 'walk_admin', 'Screen Walker (dev fixture)', 'ACTIVE')
     ON CONFLICT (telegram_id) DO UPDATE SET status = 'ACTIVE', deleted_at = NULL
     RETURNING id`,
    [WALK_TG],
  );
  const id = row.rows[0]!.id;
  await query(`UPDATE users SET plan_id = (SELECT id FROM plans WHERE code = 'premium'), expires_at = NULL WHERE id = $1`, [id]);
  await query(
    `INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code = 'admin' ON CONFLICT DO NOTHING`,
    [id],
  );
  const sip = await query('SELECT 1 FROM sip_accounts WHERE user_id = $1 AND status = $2', [id, 'ACTIVE']);
  if (sip.rows.length === 0) await provisionSipAccount(id, { actorId: id });
  return id;
}

function hasNavigation(screen: Screen): boolean {
  return screen.buttons.some((b) => NAV.test(b));
}

async function main(): Promise<void> {
  await runMigrations();
  setFreePBX(new MockFreePBXClient());

  // The walker drives the bot as its OWN throwaway admin, never as the operator
  // whose id is in TELEGRAM_SUPER_ADMIN_IDS: running this script must not
  // approve, provision or consume the plan of a real account.
  await ensureWalkerAccount();

  const bot = createBot({ apiFetch: makeFetch() });
  if (!bot) {
    console.log('TELEGRAM_BOT_TOKEN is not set in .env, so createBot() returned null.');
    return;
  }

  // grammY needs botInfo before handleUpdate(); the stub answers getMe.
  await bot.init();

  // The walker needs the callback data behind each button, so it re-reads the
  // keyboard grammar the same way a user would: by tapping labels in order.
  const taps: Array<{ label: string; data: string }> = [
    { label: 'Main Menu', data: 'm:main' },
    { label: 'Get Number', data: 'm:get' },
    { label: 'My Numbers', data: 'm:nums' },
    { label: 'SIP Info', data: 'm:sip' },
    { label: 'My Calls', data: 'm:calls' },
    { label: 'Referral', data: 'm:ref' },
    { label: 'My referrals', data: 'r:list' },
    { label: 'Support', data: 'm:sup' },
    { label: 'Admin Panel', data: 'a:home' },
    { label: 'Dashboard', data: 'a:dash' },
    { label: 'Users', data: 'a:users' },
    { label: 'Numbers', data: 'a:numbers' },
    { label: 'Inventory', data: 'a:nlist:ALL:0' },
    { label: 'Services', data: 'a:services' },
    { label: 'Countries', data: 'a:countries' },
    { label: 'Plans', data: 'a:plans' },
    { label: 'Live Calls', data: 'a:live' },
    { label: 'Call History', data: 'a:calls' },
    { label: 'Referrals (admin)', data: 'a:ref' },
    { label: 'Settings', data: 'a:settings' },
    { label: 'Findings', data: 'a:findings' },
    { label: 'Health', data: 'a:health' },
    { label: 'Audit Log', data: 'a:audit' },
    { label: 'Routes', data: 'a:routes' },
    { label: 'Import history', data: 'a:nbatches' },
    { label: 'Payout queue', data: 'a:refpay' },
  ];

  await type_(bot, '/start');
  await tap(bot, 'm:main', 'Main Menu');
  for (const t of taps) {
    currentPath = ['Main Menu', t.label];
    // country/service screens need their own ids; they are exercised separately
    try {
      await bot.handleUpdate(callbackUpdate(t.data) as never);
    } catch (err) {
      screens.push({ path: `${t.label} (ERROR)`, text: (err as Error).message, buttons: [] });
    }
  }

  // --- Get Number flow, all the way to the confirmation screen. The confirm
  //     button used to carry three uuid-s (116 bytes) and Telegram silently
  //     refused the whole message, so this walk is a regression guard. --------
  const walkCountry = await query<{ id: string }>('SELECT id FROM countries ORDER BY sort_order LIMIT 1');
  const walkService = await query<{ id: string }>(
    `SELECT DISTINCT service_id AS id FROM numbers WHERE country_id = $1 AND status = 'AVAILABLE' AND deleted_at IS NULL LIMIT 1`,
    [walkCountry.rows[0]!.id],
  );
  if (walkCountry.rows[0] && walkService.rows[0]) {
    // Start from a clean navigation stack so the walk below is deterministic.
    await bot.handleUpdate(callbackUpdate('m:main') as never);
    currentPath = ['Get Number flow'];
    await bot.handleUpdate(callbackUpdate('m:get') as never);
    currentPath = ['Get Number flow', 'country picked'];
    await bot.handleUpdate(callbackUpdate(`n:c:${walkCountry.rows[0].id}`) as never);
    currentPath = ['Get Number flow', 'service picked'];
    // The country now travels in the session, so the button carries the service only.
    await bot.handleUpdate(callbackUpdate(`n:s:${walkService.rows[0].id}`) as never);
  }

  // --- Back round-trip: the confirm screen must walk back through the pickers
  //     and land on the Main Menu, never on a screen with no way out. ---------
  currentPath = ['back walk'];
  const before = screens.length;
  await bot.handleUpdate(callbackUpdate('nav:back') as never);
  const afterFirst = screens[screens.length - 1];
  await bot.handleUpdate(callbackUpdate('nav:back') as never);
  const afterSecond = screens[screens.length - 1];
  await bot.handleUpdate(callbackUpdate('nav:back') as never);
  const afterThird = screens[screens.length - 1];
  console.log('\n--- Back round-trip (from the Get Number confirm screen) ---');
  const head = (screen: typeof afterFirst): string => (screen ? screen.text.split('\n')[0]!.slice(0, 60) : '(no screen)');
  console.log(`  1st Back → ${head(afterFirst)}`);
  console.log(`  2nd Back → ${head(afterSecond)}`);
  console.log(`  3rd Back → ${head(afterThird)}`);
  void before;

  // --- Admin wizards: every step must render, and every button must fit in 64
  //     bytes of callback data (the wizard used to pack three uuids into one). -
  const wizardCountry = walkCountry.rows[0];
  const wizardService = await query<{ id: string }>('SELECT id FROM services ORDER BY sort_order LIMIT 1');
  if (wizardCountry && wizardService.rows[0]) {
    await bot.handleUpdate(callbackUpdate('a:nadd') as never);
    currentPath = ['Add numbers wizard', 'service step'];
    await bot.handleUpdate(callbackUpdate(`a:nacountry:${wizardCountry.id}`) as never);
    currentPath = ['Add numbers wizard', 'plan step'];
    await bot.handleUpdate(callbackUpdate(`a:naservice:${wizardService.rows[0].id}`) as never);

    await bot.handleUpdate(callbackUpdate('a:ncsv') as never);
    currentPath = ['CSV import wizard', 'service step'];
    await bot.handleUpdate(callbackUpdate(`a:ncscountry:${wizardCountry.id}`) as never);
    currentPath = ['CSV import wizard', 'plan step'];
    await bot.handleUpdate(callbackUpdate(`a:ncsservice:${wizardService.rows[0].id}`) as never);
    ctxReset(ctxSessionHolder);
  }

  // --- Removal screens (spec §8, §9, §17): the previews are rendered here, the
  //     confirming taps are NOT pressed - they remove real rows. ----------------
  await bot.handleUpdate(callbackUpdate('a:numbers') as never);
  currentPath = ['Remove all available numbers'];
  await bot.handleUpdate(callbackUpdate('a:nwipe') as never);

  if (wizardCountry) {
    currentPath = ['Country detail'];
    await bot.handleUpdate(callbackUpdate(`a:ctry:${wizardCountry.id}`) as never);
    currentPath = ['Remove country (preview)'];
    await bot.handleUpdate(callbackUpdate(`a:ctrydel:${wizardCountry.id}`) as never);
  }
  if (wizardService.rows[0]) {
    currentPath = ['Service detail'];
    await bot.handleUpdate(callbackUpdate(`a:svc:${wizardService.rows[0].id}`) as never);
    currentPath = ['Remove service (preview)'];
    await bot.handleUpdate(callbackUpdate(`a:svcdel:${wizardService.rows[0].id}`) as never);
  }

  // --- Assign / reassign: the candidate list is rendered from the session ----
  const anyNumber = await query<{ id: string; status: string }>(
    "SELECT id, status FROM numbers WHERE deleted_at IS NULL ORDER BY (status = 'AVAILABLE') DESC LIMIT 1",
  );
  if (anyNumber.rows[0]) {
    currentPath = ['Number detail'];
    await bot.handleUpdate(callbackUpdate(`a:n:${anyNumber.rows[0].id}`) as never);
    currentPath = ['Assign to user'];
    await bot.handleUpdate(callbackUpdate(`a:nassign:${anyNumber.rows[0].id}`) as never);
  }

  // --- Operator bootstrap: a PENDING account holding a staff role must never
  //     see "pending approval" - it is activated on the spot. ------------------
  const staffChat = TEST_CHAT + 1;
  const staffTg = 555_000_222;
  const staff = await query<{ id: string }>(
    `INSERT INTO users (telegram_id, username, display_name, status)
     VALUES ($1, 'walk_staff', 'Walk Staff', 'PENDING')
     ON CONFLICT (telegram_id) DO UPDATE SET status = 'PENDING', deleted_at = NULL
     RETURNING id`,
    [staffTg],
  );
  const staffId = staff.rows[0]!.id;
  await query(
    `INSERT INTO user_roles (user_id, role_id)
     SELECT $1, id FROM roles WHERE code = 'super_admin'
     ON CONFLICT DO NOTHING`,
    [staffId],
  );
  currentPath = ['operator bootstrap'];
  lastByChat.delete(staffChat);
  allByChat.delete(staffChat);
  await type_(bot, '/start', staffChat, staffTg, 'walk_staff');
  const staffMsgs = allByChat.get(staffChat) ?? [];
  const staffText = staffMsgs.map((m) => m.text).join('\n');
  console.log('\n--- Operator bootstrap (PENDING super_admin taps /start) ---');
  console.log(`  first reply: ${(staffMsgs[0]?.text ?? '(nothing sent)').split('\n').slice(0, 3).join(' / ').slice(0, 110)}`);
  console.log(`  last screen: ${(staffMsgs[staffMsgs.length - 1]?.text ?? '-').split('\n')[0]!.slice(0, 70)}`);
  const staffRow = await query<{ status: string; approved_at: string | null }>('SELECT status, approved_at FROM users WHERE id = $1', [staffId]);
  const sip = await query<{ extension: string; status: string }>(
    'SELECT extension, status FROM sip_accounts WHERE user_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1',
    [staffId],
  );
  console.log(`  db: status=${staffRow.rows[0]?.status} approved_at=${staffRow.rows[0]?.approved_at ? 'set' : 'null'} sip=${sip.rows[0]?.extension ?? 'none'} (${sip.rows[0]?.status ?? '-'})`);
  if (/pending/i.test(staffText)) console.log('  ! FAIL: the account was still shown as pending');
  else if (staffRow.rows[0]?.status === 'ACTIVE' && sip.rows[0]) console.log('  ✅ auto-approved, no manual action, SIP account provisioned');
  await query("DELETE FROM bot_sessions WHERE key LIKE $1", [`%${staffChat}%`]);

  const rows = problemsOnly ? screens.filter((s) => !hasNavigation(s)) : screens;
  for (const s of rows) {
    console.log(`\n=== ${s.path}`);
    console.log(`    ${s.text.split('\n').slice(0, 2).join(' / ').slice(0, 110)}`);
    console.log(`    buttons: ${s.buttons.length ? s.buttons.join(' | ') : '(NONE)'}`);
  }

  const missing = screens.filter((s) => !hasNavigation(s));
  console.log(`\n${screens.length} screens rendered, ${missing.length} without any navigation button.`);
  for (const s of missing) console.log(`  ! ${s.path}`);

  // Tidy up after the scenario above. The throwaway operator account cannot be
  // hard-deleted (audit_logs is append-only, and its FK blocks the delete), so
  // it is soft-deleted the way the application does it; the next run reuses the
  // same telegram id.
  await query('DELETE FROM bot_sessions WHERE key LIKE $1', [`%${TEST_CHAT}%`]);
  await query('DELETE FROM bot_sessions WHERE key LIKE $1', [`%${staffChat}%`]);
  await deleteSipAccount(staffId, { actorId: staffId, force: true }).catch(() => undefined);
  await query("UPDATE users SET status = 'DELETED', deleted_at = now() WHERE id = $1", [staffId]);
  // The fake account has no Telegram chat, so its notification would retry
  // forever against a chat that does not exist.
  await query("UPDATE notifications SET status = 'FAILED' WHERE user_id = $1 AND status IN ('PENDING','FAILED')", [staffId]);

  // The walker's own admin fixture is removed too, so the operator's admin
  // panel only ever shows real accounts. It is recreated on the next run.
  const walker = await findUserForTelegram(WALK_TG);
  if (walker) {
    await deleteSipAccount(walker.id, { actorId: walker.id, force: true }).catch(() => undefined);
    await query("UPDATE users SET status = 'DELETED', deleted_at = now() WHERE id = $1", [walker.id]);
    await query("UPDATE notifications SET status = 'FAILED' WHERE user_id = $1 AND status IN ('PENDING','FAILED')", [walker.id]);
  }
  await query("DELETE FROM bot_sessions WHERE key LIKE $1", [`%${TEST_CHAT}%`]);
  await closePool();
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => closePool().catch(() => undefined));
