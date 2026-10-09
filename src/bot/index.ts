import { Bot, GrammyError, HttpError, InlineKeyboard, session } from 'grammy';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { metrics } from '../lib/metrics.js';
import { toAppError } from '../lib/errors.js';
import type { BotContext } from './context.js';
import { newRequestId } from './context.js';
import { createPgSessionStorage, initialSession, purgeOldSessions, type SessionData } from './session.js';
import {
  NAV_BACK,
  currentScreen,
  isReplayable,
  lastRendered,
  markRendered,
  popNav,
  pushNav,
  takeTop,
  resetNav,
} from './nav.js';
import { isScreenStillValid } from './screen-validity.js';
import { CB, backToMenuKeyboard, mainMenuKeyboard } from './keyboards.js';
import { sanitizeInlineKeyboard } from './callback-data.js';
import { handleCaptchaAnswer, handleHelp, handleStart, handleStartCancel, handleStartRecheck } from './handlers/start.js';
import {
  handleCancel,
  handleConfirmGetNumber,
  handleCountryPages,
  handleCountryPick,
  handleGetNumber,
  handleDepositAmountInput,
  handleDepositCancelPending,
  handleDepositMethodPick,
  handleDepositNoteInput,
  handleDepositStart,
  handleMainMenu,
  handleWallet,
  handleMyCalls,
  handleMyCallsPage,
  handleMyNumbers,
  handleNoop,
  handleNumberInfo,
  handleReferral,
  handleReferralList,
  handleReleaseConfirmPrompt,
  handleReleaseExecute,
  handleReleasePick,
  handleServicePick,
  handleSipInfo,
  handleSipPlain,
  handleSipRotate,
  handleSipRotateConfirm,
  handleSupport,
  handleSupportMessage,
  renderMainMenu,
} from './handlers/user.js';
import {
  handleAdminHome,
  handleDeposits,
  handleDepositApprove,
  handleDepositReject,
  handlePaymentMethodAddAddress,
  handlePaymentMethodAddName,
  handlePaymentMethodAddStart,
  handlePaymentMethodDelete,
  handlePaymentMethodDetail,
  handlePaymentMethodEditAddress,
  handlePaymentMethodEditStart,
  handlePaymentMethodToggle,
  handlePaymentMethods,
  handleFundAmountInput,
  handleFundStart,
  handleAuditLog,
  handleBroadcastSend,
  handleBroadcastStart,
  handleCallHistory,
  handleCommissionPay,
  handleCommissionPayPrompt,
  handleCommissionReject,
  handleCountriesMenu,
  handleCountryAddStart,
  handleCountryDelete,
  handleCountryDeleteConfirm,
  handleCountryDetail,
  handleCountryEditStart,
  handleCountryToggle,
  handleDashboard,
  handleFindings,
  handleHealth,
  handleImportBatches,
  handleLiveCalls,
  handleNumberAddCountry,
  handleNumberAddInput,
  handleNumberAddPlan,
  handleNumberAddService,
  handleNumberAddStart,
  handleNumberAssignConfirm,
  handleNumberAssignStart,
  handleNumberCsvCountry,
  handleNumberCsvInput,
  handleNumberCsvPlan,
  handleNumberCsvService,
  handleNumberCsvStart,
  handleNumbersWipeConfirm,
  handleNumbersWipeStart,
  handleNumberDelete,
  handleNumberDeleteConfirm,
  handleNumberDetail,
  handleNumberList,
  handleNumberReassignConfirm,
  handleNumberReassignStart,
  handleNumberRelease,
  handleNumberReleaseConfirm,
  handleNumberResync,
  handleNumberSuspend,
  handleNumberSuspendConfirm,
  handleNumberUnsuspend,
  handleNumbersMenu,
  handlePayoutQueue,
  handlePlanAdjust,
  handlePlanDetail,
  handlePlansMenu,
  handleProbePbx,
  handleReferralsAdmin,
  handleResolveFinding,
  handleRoutesOverview,
  handleRunReconciliation,
  handleServiceAddStart,
  handleServiceDelete,
  handleServiceDeleteConfirm,
  handleServiceDetail,
  handleServiceEditStart,
  handleServiceToggle,
  handleServicesMenu,
  handleSettingEditStart,
  handleSettingsMenu,
  handleTopReferrers,
  handleUserApprove,
  handleUserBlock,
  handleUserBlockConfirm,
  handleUserCalls,
  handleUserDelete,
  handleUserDeleteConfirm,
  handleUserDetail,
  handleUserList,
  handleUserNumbers,
  handleUserPlanPicker,
  handleUserPlanSet,
  handleUserReferral,
  handleUserReject,
  handleUserRejectConfirm,
  handleUserRoleToggle,
  handleUserRoles,
  handleUserSearch,
  handleUserSearchQuery,
  handleUserSipCredentials,
  handleUserUnblock,
} from './handlers/admin.js';
import { createService, createCountry, getService, getCountry, updateCountry, updateService } from '../services/catalog.service.js';
import { setSetting } from '../services/settings.service.js';
import { AppError } from '../lib/errors.js';

/**
 * Bot assembly.
 *
 * Middleware order matters and is deliberate:
 *   1. request id + logging           (observability for every update)
 *   2. session                        (persistent conversation state)
 *   3. identity & RBAC                (who is this, what may they do)
 *   4. rate limiting                  (per user, per action class)
 *   5. handlers                       (all inline-keyboard driven)
 *   6. error boundary                 (never crash, never leak internals)
 */

export type AppBot = Bot<BotContext>;

/**
 * Builds the bot.
 *
 * @param opts.apiFetch Test/CLI hook: replace grammY's HTTP client. It lets the
 *        navigation and screen tests drive the real handlers without talking to
 *        Telegram (see tests/navigation.test.ts) - the alternative would be
 *        asserting on hand-written keyboard objects, which proves nothing about
 *        what a user actually sees.
 */
// True while the Back handler re-dispatches the previous screen through the
// dispatcher; that render must not be recorded as a navigation step.
let replayingBack = false;

/** PostgreSQL-backed session storage, reused when Back has to flush a pop. */
const sessionStorage = createPgSessionStorage<SessionData>();

export function createBot(opts: { apiFetch?: typeof fetch; token?: string } = {}): AppBot | null {
  // `token` and `apiFetch` are injection points for the screen walker and the
  // tests; production always uses the environment token.
  const token = opts.token ?? env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    logger.warn('TELEGRAM_BOT_TOKEN is not set: the Telegram bot will not start (API and workers still run)');
    return null;
  }

  const bot = new Bot<BotContext>(token, opts.apiFetch ? { client: { fetch: opts.apiFetch } } : {});

  // ---------------------------------------------------------------------------
  // 0. outgoing guard: a button Telegram cannot accept must never blank a screen
  // ---------------------------------------------------------------------------
  // Telegram answers BUTTON_DATA_INVALID (400) when any callback_data is longer
  // than 64 bytes, and then delivers *nothing* - the user sees a screen that
  // never appeared. Oversized buttons are logged as errors and removed from the
  // keyboard, so the rest of the screen still renders.
  bot.api.config.use(async (prev, method, payload, signal) => {
    const markup = (payload as { reply_markup?: unknown }).reply_markup;
    const { violations, cleaned } = sanitizeInlineKeyboard(markup);
    if (violations.length > 0) {
      metrics.counters.invalidCallbackData.inc(violations.length);
      metrics.counters.droppedButtons.inc(violations.length);
      for (const v of violations) {
        logger.error(
          { method, button: v.text, bytes: v.bytes, reason: v.reason, callbackData: v.data },
          'callback_data exceeds Telegram\'s 64-byte limit: the button was dropped so the message could be delivered',
        );
      }
      if (cleaned) {
        return prev(method, { ...(payload as object), reply_markup: cleaned } as never, signal);
      }
      // No button left at all: send the text without a keyboard.
      const { reply_markup: _dropped, ...rest } = payload as Record<string, unknown>;
      return prev(method, rest as never, signal);
    }
    return prev(method, payload, signal);
  });

  // ---------------------------------------------------------------------------
  // 1. request context + logging
  // ---------------------------------------------------------------------------
  bot.use(async (ctx, next) => {
    ctx.state = {
      requestId: newRequestId(),
      role: 'user',
      isAdmin: false,
      isSuperAdmin: false,
    };
    const started = Date.now();
    metrics.counters.telegramUpdates.inc(1, { kind: ctx.callbackQuery ? 'callback' : 'message' });
    try {
      await next();
    } finally {
      logger.debug(
        {
          requestId: ctx.state.requestId,
          updateId: ctx.update.update_id,
          kind: ctx.callbackQuery?.data ?? ctx.message?.text?.slice(0, 40) ?? 'update',
          ms: Date.now() - started,
        },
        'update handled',
      );
    }
  });

  // ---------------------------------------------------------------------------
  // 2. session (PostgreSQL-backed)
  // ---------------------------------------------------------------------------
  bot.use(
    session<SessionData, BotContext>({
      initial: initialSession,
      storage: sessionStorage,
      getSessionKey: (ctx) => (ctx.chat && ctx.from ? `${ctx.chat.id}:${ctx.from.id}` : undefined),
    }),
  );

  // ---------------------------------------------------------------------------
  // 3. identity + RBAC + ban check
  // ---------------------------------------------------------------------------
  bot.use(async (ctx, next) => {
    const from = ctx.from;
    if (!from || from.is_bot) return;

    const { findUserForTelegram, resolveRole, touchLastSeen, upsertTelegramAccount, getTelegramAccount } = await import('../services/user.service.js');

    const account = await getTelegramAccount(from.id);
    if (account?.banned) {
      // Silently drop: banned accounts must not be able to probe the bot.
      logger.warn({ telegramId: from.id }, 'update from banned telegram account ignored');
      return;
    }

    await upsertTelegramAccount({
      telegramId: from.id,
      chatId: ctx.chat?.id,
      username: from.username ?? null,
      firstName: from.first_name ?? null,
      lastName: from.last_name ?? null,
      languageCode: from.language_code ?? null,
      lastUpdateId: ctx.update.update_id,
    });

    const user = await findUserForTelegram(from.id);
    ctx.state.user = user ?? undefined;
    ctx.state.role = await resolveRole(from.id, user?.id ?? null);
    ctx.state.isAdmin = ['super_admin', 'admin', 'support'].includes(ctx.state.role);
    ctx.state.isSuperAdmin = ctx.state.role === 'super_admin';

    if (user && ctx.callbackQuery) void touchLastSeen(user.id).catch(() => undefined);
    await next();
  });

  // ---------------------------------------------------------------------------
  // 3b. navigation stack ("⬅️ Back" always returns where you came from)
  // ---------------------------------------------------------------------------
  // Runs AFTER the handlers: the screen is recorded once it has actually been
  // rendered, so a handler that fails cannot leave a broken stack entry. Only
  // pure-render callbacks are recorded - see src/bot/nav.ts.
  bot.use(async (ctx, next) => {
    const data = ctx.callbackQuery?.data;
    await next();
    if (!data || data === NAV_BACK) return;
    if (data === CB.MAIN_MENU) {
      resetNav(ctx);
      return;
    }
    // Remember what the user is looking at - including transient screens
    // (confirmations, previews, removal receipts) that stay off the stack.
    // The re-render performed by Back is the *result* of Back, not a new
    // navigation step: replayingBack keeps it out of the stack bookkeeping.
    if (!replayingBack) {
      markRendered(ctx, data);
      if (isReplayable(data)) pushNav(ctx, data);
    }
  });

  // ---------------------------------------------------------------------------
  // 4. rate limiting for the expensive flows
  // ---------------------------------------------------------------------------
  const limiters = {
    getNumber: new Map<number, number[]>(),
    support: new Map<number, number[]>(),
  };

  const throttle = (bucket: Map<number, number[]>, telegramId: number, perMinute: number): boolean => {
    const now = Date.now();
    const hits = (bucket.get(telegramId) ?? []).filter((t) => now - t < 60_000);
    if (hits.length >= perMinute) {
      bucket.set(telegramId, hits);
      return false;
    }
    hits.push(now);
    bucket.set(telegramId, hits);
    return true;
  };

  bot.use(async (ctx, next) => {
    const from = ctx.from;
    if (!from) return next();

    const step = ctx.session?.step;

    // A pending text step ("waiting for your support message") is only relevant
    // to the next TEXT message. A button tap means the user moved on, so the step
    // is cleared here. Without this, tapping Support once left the session in
    // `support_message` and the support throttle below swallowed the following
    // taps - the screen simply never changed, which reads as "the buttons are
    // broken".
    if (ctx.callbackQuery && step?.type === 'support_message') {
      ctx.session.step = undefined;
    }

    // Number requests (spec §37) - the expensive flow, throttled on the tap.
    if (ctx.callbackQuery?.data?.startsWith('n:get:')) {
      const maxPerMinute = await (await import('../services/settings.service.js')).getNumber('numbers.max_requests_per_minute', env.MAX_NUMBER_REQUESTS_PER_MINUTE);
      if (!throttle(limiters.getNumber, from.id, maxPerMinute)) {
        metrics.counters.rateLimited.inc(1, { kind: 'get_number' });
        await ctx.answerCallbackQuery({ text: '⏳ Too many requests. Please wait a minute.', show_alert: true }).catch(() => undefined);
        return;
      }
    }

    // Support messages: throttle the messages, never the taps.
    if (!ctx.callbackQuery && step?.type === 'support_message') {
      if (!throttle(limiters.support, from.id, 5)) {
        await ctx.reply('⏳ You are sending messages too quickly. Please wait a moment.');
        return;
      }
    }

    return next();
  });

  // ---------------------------------------------------------------------------
  // 5a. commands
  // ---------------------------------------------------------------------------
  bot.command('start', handleStart);
  bot.command('menu', async (ctx) => {
    if (!ctx.state.user) return handleStart(ctx);
    await renderMainMenu(ctx);
  });
  bot.command('help', handleHelp);
  bot.command('cancel', async (ctx) => {
    ctx.session.step = undefined;
    await ctx.reply('✅ Cancelled.', { reply_markup: mainMenuKeyboard(ctx.state.isAdmin) });
  });
  // /admin is deliberately NOT a command: the admin panel is reached through the
  // menu button, which is only rendered for accounts that resolve to an admin
  // role (TELEGRAM_SUPER_ADMIN_IDS or a user_roles row). Typing it still answers
  // helpfully instead of dead-ending.
  bot.hears(/^\/admin(@\w+)?$/i, async (ctx) => {
    await ctx.reply(
      ctx.state.isAdmin
        ? '🛠 Open the admin panel with the <b>Admin Panel</b> button below.'
        : '⛔️ You are not an administrator.',
      { parse_mode: 'HTML', reply_markup: mainMenuKeyboard(ctx.state.isAdmin) },
    );
  });

  // Anything else typed is treated as input for the current step, otherwise the
  // menu is shown (spec §33: typed commands are never required).
  bot.on('message', async (ctx, next) => {
    if (ctx.message.text?.startsWith('/')) return next();
    await next();
  });

  // ---------------------------------------------------------------------------
  // 5b. user handlers
  // ---------------------------------------------------------------------------
  // Universal back: pop one level and re-dispatch the previous screen through
  // the normal dispatcher, so it re-renders with fresh data and its own keyboard.
  bot.callbackQuery(NAV_BACK, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => undefined);
    /*
     * Back means "leave the screen I am looking at".
     *
     * Ordinary screens push themselves onto the stack, so the top of the stack
     * *is* the screen being looked at and popping it yields the parent.
     * Transient screens (confirmation, preview, the "removed" receipt) stay off
     * the stack on purpose - re-dispatching one would repeat a mutation - so
     * popping there would silently skip their parent. For those, the stack top
     * already is the parent: render it without popping.
     */
    const stackTop = currentScreen(ctx);
    const rendered = lastRendered(ctx);
    const transient = rendered !== null && rendered !== stackTop;

    let previous = transient ? takeTop(ctx) : popNav(ctx);

    /*
     * Skip entries whose entity is gone. An admin who removes a country and
     * presses Back must not be sent to that country's (now impossible) screen:
     * the old handler returned without sending anything, so the button looked
     * dead. Walk further up the stack instead, ending at the main menu.
     */
    for (let hops = 0; previous && hops < 10; hops += 1) {
      try {
        if (await isScreenStillValid(previous)) break;
      } catch {
        // A validation failure must never break Back: treat it as valid.
        break;
      }
      logger.debug({ screen: previous }, 'skipping a Back target that no longer exists');
      previous = popNav(ctx);
    }

    if (!previous) {
      await renderMainMenu(ctx, { edit: true });
      return;
    }
    const query = ctx.callbackQuery;
    if (!query || !('message' in query) || !query.message) {
      await renderMainMenu(ctx, { edit: true });
      return;
    }
    // Persist the popped stack BEFORE the nested update runs: the nested ctx
    // loads its session from storage, so an unsaved pop would come back as a
    // phantom level and the next Back would repeat a screen.
    const sessionKey = ctx.chat && ctx.from ? `${ctx.chat.id}:${ctx.from.id}` : null;
    if (sessionKey) {
      try {
        await sessionStorage.write(sessionKey, ctx.session);
      } catch {
        // A failed flush is not fatal: the nested update then works from the
        // stored state, which is the pre-Back stack.
      }
    }

    replayingBack = true;
    try {
      await bot.handleUpdate({
        update_id: ctx.update.update_id + 1_000_000 + Math.floor(Math.random() * 1000),
        callback_query: {
          id: `${query.id}-back`,
          from: ctx.from!,
          chat_instance: query.chat_instance,
          message: query.message,
          data: previous,
        },
      } as never);
    } finally {
      replayingBack = false;
    }
    // The user is now looking at `previous` (rendered by the nested update).
    markRendered(ctx, previous);
  });

  bot.callbackQuery(CB.MAIN_MENU, async (ctx) => {
    resetNav(ctx);
    await handleMainMenu(ctx);
  });
  bot.callbackQuery(CB.GET_NUMBER, handleGetNumber);
  bot.callbackQuery(CB.MY_NUMBERS, handleMyNumbers);
  bot.callbackQuery(CB.SIP_INFO, handleSipInfo);
  bot.callbackQuery(CB.MY_CALLS, async (ctx) => handleMyCalls(ctx));
  bot.callbackQuery(CB.REFERRAL, handleReferral);
  bot.callbackQuery(CB.SUPPORT, handleSupport);
  bot.callbackQuery(CB.WALLET, handleWallet);
  bot.callbackQuery(CB.DEPOSIT, handleDepositStart);
  bot.callbackQuery(/^dep:m:([0-9a-f-]{36})$/, async (ctx) => handleDepositMethodPick(ctx, ctx.match[1]!));
  bot.callbackQuery('dep:cancel', handleDepositCancelPending);
  bot.callbackQuery('noop', handleNoop);
  bot.callbackQuery('m:cancel', handleCancel);

  bot.callbackQuery('start:recheck', handleStartRecheck);
  bot.callbackQuery('start:pending', async (ctx) => {
    const { handlePendingCheck } = await import('./handlers/start.js');
    return handlePendingCheck(ctx);
  });
  bot.callbackQuery('start:cancel', handleStartCancel);

  bot.callbackQuery(/^n:cp:(\d+)$/, async (ctx) => handleCountryPages(ctx, Number(ctx.match[1])));
  bot.callbackQuery(/^n:c:([0-9a-f-]{36})$/, async (ctx) => handleCountryPick(ctx, ctx.match[1]!));
  bot.callbackQuery(/^n:s:([0-9a-f-]{36})$/, async (ctx) => handleServicePick(ctx, ctx.match[1]!));
  bot.callbackQuery(/^n:get:([0-9a-f-]{36}):(FREE|PREMIUM)$/, async (ctx) =>
    handleConfirmGetNumber(ctx, ctx.match[1]!, ctx.match[2] as 'FREE' | 'PREMIUM'),
  );
  bot.callbackQuery(/^n:back:countries$/, handleGetNumber);
  bot.callbackQuery(/^n:back:services:([0-9a-f-]{36})$/, async (ctx) => handleCountryPick(ctx, ctx.match[1]!));
  bot.callbackQuery(/^n:info:([0-9a-f-]{36})$/, async (ctx) => handleNumberInfo(ctx, ctx.match[1]!));
  bot.callbackQuery('n:release:pick', handleReleasePick);
  bot.callbackQuery(/^n:relok:([0-9a-f-]{36})$/, async (ctx) => handleReleaseConfirmPrompt(ctx, ctx.match[1]!));
  bot.callbackQuery(/^n:relyes:([0-9a-f-]{36})$/, async (ctx) => handleReleaseExecute(ctx, ctx.match[1]!));

  bot.callbackQuery('s:rotate', handleSipRotate);
  bot.callbackQuery('s:rotok', handleSipRotateConfirm);
  bot.callbackQuery('s:plain', handleSipPlain);

  bot.callbackQuery(/^c:page:(\d+)$/, async (ctx) => handleMyCallsPage(ctx, Number(ctx.match[1])));
  bot.callbackQuery('r:list', handleReferralList);

  // ---------------------------------------------------------------------------
  // 5c. admin handlers (guarded by requireAdmin)
  // ---------------------------------------------------------------------------
  const requireAdmin = async (ctx: BotContext, next: () => Promise<void>): Promise<void> => {
    if (!ctx.state.isAdmin) {
      await ctx.answerCallbackQuery({ text: '⛔️ Administrators only.', show_alert: true }).catch(() => undefined);
      logger.warn({ telegramId: ctx.from?.id, data: ctx.callbackQuery?.data }, 'non-admin attempted an admin action');
      return;
    }
    await next();
  };

  const requireSuperAdmin = async (ctx: BotContext, next: () => Promise<void>): Promise<void> => {
    if (!ctx.state.isSuperAdmin) {
      await ctx.answerCallbackQuery({ text: '⛔️ Super admin only.', show_alert: true }).catch(() => undefined);
      return;
    }
    await next();
  };

  const A = (pattern: string | RegExp, handler: (ctx: BotContext, ...args: string[]) => Promise<void>) => {
    bot.callbackQuery(pattern, requireAdmin, async (ctx) => {
      const match = ctx.match;
      const args = Array.isArray(match) ? match.slice(1).map((v) => String(v ?? '')) : [];
      await handler(ctx, ...args);
    });
  };

  A(CB.ADMIN, handleAdminHome);
  A('a:dash', handleDashboard);
  A('a:users', async (ctx) => handleUserList(ctx, 'PENDING', 0));
  A('a:deps', handleDeposits);
  A('a:pms', handlePaymentMethods);
  A(/^a:pm:([0-9a-f-]{36})$/, async (ctx, id) => handlePaymentMethodDetail(ctx, id!));
  A(/^a:pmon:([0-9a-f-]{36})$/, async (ctx, id) => handlePaymentMethodToggle(ctx, id!, 'ACTIVE'));
  A(/^a:pmoff:([0-9a-f-]{36})$/, async (ctx, id) => handlePaymentMethodToggle(ctx, id!, 'DISABLED'));
  A(/^a:pmdel:([0-9a-f-]{36})$/, async (ctx, id) => handlePaymentMethodDelete(ctx, id!));
  A('a:pmadd', handlePaymentMethodAddStart);
  A(/^a:pmedit:([0-9a-f-]{36})$/, async (ctx, id) => handlePaymentMethodEditStart(ctx, id!));
  A(/^a:dpok:([0-9a-f-]{36})$/, async (ctx, id) => handleDepositApprove(ctx, id!));
  A(/^a:dpno:([0-9a-f-]{36})$/, async (ctx, id) => handleDepositReject(ctx, id!));
  A(/^a:fund:([0-9a-f-]{36})$/, async (ctx, userId) => handleFundStart(ctx, userId!));
  A(/^a:ul:(ALL|PENDING|ACTIVE|BLOCKED|EXPIRED):(\d+)$/, async (ctx, filter, page) => handleUserList(ctx, filter!, Number(page)));
  A(/^a:u:([0-9a-f-]{36})$/, async (ctx, userId) => handleUserDetail(ctx, userId!));
  A(/^a:uap:([0-9a-f-]{36})$/, async (ctx, userId) => handleUserApprove(ctx, userId!));
  A(/^a:urej:([0-9a-f-]{36})$/, async (ctx, userId) => handleUserReject(ctx, userId!));
  A(/^a:urejok:([0-9a-f-]{36})$/, async (ctx, userId) => handleUserRejectConfirm(ctx, userId!));
  A(/^a:ublk:([0-9a-f-]{36})$/, async (ctx, userId) => handleUserBlock(ctx, userId!));
  A(/^a:ublkok:([0-9a-f-]{36})$/, async (ctx, userId) => handleUserBlockConfirm(ctx, userId!));
  A(/^a:uunb:([0-9a-f-]{36})$/, async (ctx, userId) => handleUserUnblock(ctx, userId!));
  A(/^a:udel:([0-9a-f-]{36})$/, async (ctx, userId) => handleUserDelete(ctx, userId!));
  A(/^a:udelok:([0-9a-f-]{36})$/, async (ctx, userId) => handleUserDeleteConfirm(ctx, userId!));
  A(/^a:uplan:([0-9a-f-]{36})$/, async (ctx, userId) => handleUserPlanPicker(ctx, userId!));
  A(/^a:uplanok:([0-9a-f-]{36}):([0-9a-f-]{36})$/, async (ctx, userId, planId) => handleUserPlanSet(ctx, userId!, planId!));
  A(/^a:usip:([0-9a-f-]{36})$/, async (ctx, userId) => handleUserSipCredentials(ctx, userId!));
  A(/^a:unums:([0-9a-f-]{36})$/, async (ctx, userId) => handleUserNumbers(ctx, userId!));
  A(/^a:ucalls:([0-9a-f-]{36})$/, async (ctx, userId) => handleUserCalls(ctx, userId!));
  A(/^a:uref:([0-9a-f-]{36})$/, async (ctx, userId) => handleUserReferral(ctx, userId!));
  A(/^a:uroles:([0-9a-f-]{36})$/, async (ctx, userId) => handleUserRoles(ctx, userId!));
  bot.callbackQuery(/^a:urolet:([0-9a-f-]{36}):(admin|support|user)$/, requireSuperAdmin, async (ctx) =>
    handleUserRoleToggle(ctx, ctx.match[1]!, ctx.match[2]!),
  );
  A('a:usearch', handleUserSearch);

  A('a:numbers', handleNumbersMenu);
  A(/^a:nlist:(ALL|AVAILABLE|ASSIGNED|SUSPENDED|RESERVED|EXPIRED|DISABLED):(\d+)$/, async (ctx, status, page) => handleNumberList(ctx, status!, Number(page)));
  A(/^a:n:([0-9a-f-]{36})$/, async (ctx, numberId) => handleNumberDetail(ctx, numberId!));
  A(/^a:nsusp:([0-9a-f-]{36})$/, async (ctx, numberId) => handleNumberSuspend(ctx, numberId!));
  A(/^a:nsuspok:([0-9a-f-]{36})$/, async (ctx, numberId) => handleNumberSuspendConfirm(ctx, numberId!));
  A(/^a:nunsusp:([0-9a-f-]{36})$/, async (ctx, numberId) => handleNumberUnsuspend(ctx, numberId!));
  A(/^a:nrel:([0-9a-f-]{36})$/, async (ctx, numberId) => handleNumberRelease(ctx, numberId!));
  A(/^a:nrelok:([0-9a-f-]{36})$/, async (ctx, numberId) => handleNumberReleaseConfirm(ctx, numberId!));
  A(/^a:ndel:([0-9a-f-]{36})$/, async (ctx, numberId) => handleNumberDelete(ctx, numberId!));
  A(/^a:ndelok:([0-9a-f-]{36})$/, async (ctx, numberId) => handleNumberDeleteConfirm(ctx, numberId!));
  A(/^a:nsync:([0-9a-f-]{36})$/, async (ctx, numberId) => handleNumberResync(ctx, numberId!));
  A(/^a:nreas:([0-9a-f-]{36})$/, async (ctx, numberId) => handleNumberReassignStart(ctx, numberId!));
  A(/^a:nreasok:([0-9a-f-]{36})$/, async (ctx, userId) => handleNumberReassignConfirm(ctx, userId!));
  A(/^a:nassign:([0-9a-f-]{36})$/, async (ctx, numberId) => handleNumberAssignStart(ctx, numberId!));
  A(/^a:nassignok:([0-9a-f-]{36})$/, async (ctx, userId) => handleNumberAssignConfirm(ctx, userId!));
  A('a:nadd', handleNumberAddStart);
  A(/^a:nacountry:([0-9a-f-]{36})$/, async (ctx, countryId) => handleNumberAddCountry(ctx, countryId!));
  A(/^a:naservice:([0-9a-f-]{36})$/, async (ctx, serviceId) => handleNumberAddService(ctx, serviceId!));
  A(/^a:naplan:([0-9a-f-]{36}):(FREE|PREMIUM)$/, async (ctx, serviceId, planType) =>
    handleNumberAddPlan(ctx, serviceId!, planType as 'FREE' | 'PREMIUM'),
  );
  A('a:ncsv', handleNumberCsvStart);
  A(/^a:ncscountry:([0-9a-f-]{36})$/, async (ctx, countryId) => handleNumberCsvCountry(ctx, countryId!));
  A(/^a:ncsservice:([0-9a-f-]{36})$/, async (ctx, serviceId) => handleNumberCsvService(ctx, serviceId!));
  A(/^a:ncsplan:([0-9a-f-]{36}):(FREE|PREMIUM)$/, async (ctx, serviceId, planType) =>
    handleNumberCsvPlan(ctx, serviceId!, planType as 'FREE' | 'PREMIUM'),
  );
  A('a:nwipe', handleNumbersWipeStart);
  A('a:nwipeok', handleNumbersWipeConfirm);
  A('a:nbatches', handleImportBatches);
  A('a:routes', handleRoutesOverview);

  A('a:services', handleServicesMenu);
  A(/^a:svc:([0-9a-f-]{36})$/, async (ctx, serviceId) => handleServiceDetail(ctx, serviceId!));
  A(/^a:svct:([0-9a-f-]{36})$/, async (ctx, serviceId) => handleServiceToggle(ctx, serviceId!));
  A(/^a:svce:([0-9a-f-]{36}):(name|icon|description)$/, async (ctx, serviceId, field) =>
    handleServiceEditStart(ctx, serviceId!, field as 'name' | 'icon' | 'description'),
  );
  A(/^a:svcdel:([0-9a-f-]{36})$/, async (ctx, serviceId) => handleServiceDelete(ctx, serviceId!));
  A(/^a:svcdelok:([0-9a-f-]{36})$/, async (ctx, serviceId) => handleServiceDeleteConfirm(ctx, serviceId!));
  A('a:svcadd', handleServiceAddStart);

  A('a:countries', handleCountriesMenu);
  A(/^a:ctry:([0-9a-f-]{36})$/, async (ctx, countryId) => handleCountryDetail(ctx, countryId!));
  A(/^a:ctryt:([0-9a-f-]{36})$/, async (ctx, countryId) => handleCountryToggle(ctx, countryId!));
  A(/^a:ctrye:([0-9a-f-]{36}):(name|flag|dial_code)$/, async (ctx, countryId, field) =>
    handleCountryEditStart(ctx, countryId!, field as 'name' | 'flag' | 'dial_code'),
  );
  A(/^a:ctrydel:([0-9a-f-]{36})$/, async (ctx, countryId) => handleCountryDelete(ctx, countryId!));
  A(/^a:ctrydelok:([0-9a-f-]{36})$/, async (ctx, countryId) => handleCountryDeleteConfirm(ctx, countryId!));
  A('a:ctryadd', handleCountryAddStart);

  A('a:plans', handlePlansMenu);
  A(/^a:plan:([0-9a-f-]{36})$/, async (ctx, planId) => handlePlanDetail(ctx, planId!));
  A(/^a:planmax:([0-9a-f-]{36}):(\d+)$/, async (ctx, planId, value) => handlePlanAdjust(ctx, planId!, 'max', Number(value)));
  A(/^a:planprem:([0-9a-f-]{36})$/, async (ctx, planId) => handlePlanAdjust(ctx, planId!, 'premium'));
  A(/^a:planprice:([0-9a-f-]{36})$/, async (ctx, planId) => handlePlanAdjust(ctx, planId!, 'price', 0));
  A(/^a:plandur:([0-9a-f-]{36})$/, async (ctx, planId) => handlePlanAdjust(ctx, planId!, 'duration', 30));
  A(/^a:plant:([0-9a-f-]{36})$/, async (ctx, planId) => handlePlanAdjust(ctx, planId!, 'toggle'));
  A('a:planadd', async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => undefined);
    await ctx.editMessageText('ℹ️ Create plans through the admin API (<code>POST /api/admin/plans</code>) - it validates pricing fields that a chat message cannot.', {
      parse_mode: 'HTML',
      reply_markup: backToMenuKeyboard(true),
    });
  });

  A('a:live', handleLiveCalls);
  A(/^a:calls:?(\d*)$/, async (ctx, page) => handleCallHistory(ctx, Number(page || 0)));

  A('a:ref', handleReferralsAdmin);
  A('a:reftop', handleTopReferrers);
  A('a:refpay', handlePayoutQueue);
  A(/^a:cmpayask:([0-9a-f-]{36})$/, async (ctx, commissionId) => handleCommissionPayPrompt(ctx, commissionId!));
  A(/^a:cmpay:([0-9a-f-]{36})$/, async (ctx, commissionId) => handleCommissionPay(ctx, commissionId!));
  A(/^a:cmrej:([0-9a-f-]{36})$/, async (ctx, commissionId) => handleCommissionReject(ctx, commissionId!));
  A('a:refset', handleSettingsMenu);

  A('a:settings', handleSettingsMenu);
  A(/^a:set:(.+)$/, async (ctx, key) => handleSettingEditStart(ctx, key!));

  A('a:findings', handleFindings);
  A('a:runsync', handleRunReconciliation);
  A(/^a:fresolve:([0-9a-f-]{36})$/, async (ctx, findingId) => handleResolveFinding(ctx, findingId!));
  A('a:health', handleHealth);
  A('a:probe', handleProbePbx);
  A(/^a:audit:?(\d*)$/, async (ctx, page) => handleAuditLog(ctx, Number(page || 0)));
  A('a:broadcast', handleBroadcastStart);

  // ---------------------------------------------------------------------------
  // 5d. text input for multi-step flows
  // ---------------------------------------------------------------------------
  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text?.trim() ?? '';
    if (!text || text.startsWith('/')) return;
    const step = ctx.session.step;
    if (!step) {
      // A friendly nudge instead of silence.
      if (ctx.state.user) await renderMainMenu(ctx);
      else await handleStart(ctx);
      return;
    }

    switch (step.type) {
      case 'captcha':
        await handleCaptchaAnswer(ctx, text);
        return;

      case 'support_message':
        await handleSupportMessage(ctx, text);
        return;

      case 'deposit_amount':
        await handleDepositAmountInput(ctx, text);
        return;

      case 'deposit_note':
        await handleDepositNoteInput(ctx, text);
        return;

      case 'admin_fund_amount':
        await handleFundAmountInput(ctx, text);
        return;

      case 'admin_pm_add_name':
        await handlePaymentMethodAddName(ctx, text);
        return;

      case 'admin_pm_add_address':
        await handlePaymentMethodAddAddress(ctx, text);
        return;

      case 'admin_pm_edit_address':
        await handlePaymentMethodEditAddress(ctx, text);
        return;

      case 'admin_search_user':
        await handleUserSearchQuery(ctx, text);
        return;

      case 'admin_add_numbers':
        await handleNumberAddInput(ctx, text);
        return;

      case 'admin_csv_import':
        await handleNumberCsvInput(ctx, text);
        return;

      case 'admin_broadcast':
        await handleBroadcastSend(ctx, text);
        return;

      case 'admin_set_setting': {
        ctx.session.step = undefined;
        const settings = await import('../services/settings.service.js').then((m) => m.getAllSettings());
        const setting = settings.find((s) => s.key === step.key);
        let value: unknown = text;
        try {
          if (setting?.value_type === 'number') value = Number(text);
          else if (setting?.value_type === 'boolean') value = ['true', '1', 'yes', 'on'].includes(text.toLowerCase());
          else if (setting?.value_type === 'json') value = JSON.parse(text);
          else {
            // Strings are stored as JSON strings (e.g. "EUR") so the typed
            // reader keeps working.
            const asBool = ['true', 'false'].includes(text.toLowerCase());
            value = asBool ? text.toLowerCase() === 'true' : text;
          }
        } catch {
          await ctx.reply('❌ That value is not valid. Please try again or /cancel.');
          return;
        }
        await setSetting(step.key, value, ctx.state.user?.id);
        await ctx.reply(`✅ <b>${step.label}</b> updated.`, { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('🔧 Settings', 'a:settings').row().text('🛠 Admin', 'a:home') });
        return;
      }

      case 'admin_add_country': {
        ctx.session.step = undefined;
        const parts = text.split('|').map((p) => p.trim());
        if (parts.length < 3) {
          await ctx.reply('❌ Format: <code>Name | ISO2 | dialcode | flag</code>', { parse_mode: 'HTML' });
          return;
        }
        try {
          const country = await createCountry({
            name: parts[0]!,
            iso2: parts[1]!,
            dialCode: parts[2]!,
            ...(parts[3] ? { flag: parts[3] } : {}),
          });
          await ctx.reply(
            [
              `✅ Country <b>${country.flag ?? ''} ${country.name}</b> ready.`,
              '',
              'Add numbers to it (🔢 Numbers → ➕ Add numbers) so users can order from it.',
            ].join('\n'),
            {
              parse_mode: 'HTML',
              reply_markup: new InlineKeyboard().text('🌍 Countries', 'a:countries').row().text('🛠 Admin', 'a:home'),
            },
          );
        } catch (err) {
          await ctx.reply(`❌ ${toAppError(err).userMessage}`);
        }
        return;
      }

      case 'admin_add_service': {
        ctx.session.step = undefined;
        const match = text.match(/^(\p{Emoji_Presentation}|\p{Extended_Pictographic})?\s*(.+)$/u);
        const icon = match?.[1] ?? undefined;
        const name = (match?.[2] ?? text).trim();
        try {
          const service = await createService({ name, ...(icon ? { icon } : {}) });
          await ctx.reply(
            [
              `✅ Service <b>${service.icon ?? ''} ${service.name}</b> ready.`,
              '',
              'Add numbers to it (🔢 Numbers → ➕ Add numbers) so users can order from it.',
            ].join('\n'),
            {
              parse_mode: 'HTML',
              reply_markup: new InlineKeyboard().text('📱 Services', 'a:services').row().text('🛠 Admin', 'a:home'),
            },
          );
        } catch (err) {
          await ctx.reply(`❌ ${toAppError(err).userMessage}`);
        }
        return;
      }

      case 'admin_edit_country': {
        ctx.session.step = undefined;
        try {
          const patch = step.field === 'name' ? { name: text } : step.field === 'flag' ? { flag: text } : { dialCode: text };
          await updateCountry(step.countryId, patch);
          await ctx.reply('✅ Country updated.', { reply_markup: new InlineKeyboard().text('🌍 Country', `a:ctry:${step.countryId}`) });
        } catch (err) {
          await ctx.reply(`❌ ${toAppError(err).userMessage}`);
        }
        return;
      }

      case 'admin_edit_service': {
        ctx.session.step = undefined;
        try {
          const patch = step.field === 'name' ? { name: text } : step.field === 'icon' ? { icon: text } : { description: text };
          await updateService(step.serviceId, patch);
          await ctx.reply('✅ Service updated.', { reply_markup: new InlineKeyboard().text('📱 Service', `a:svc:${step.serviceId}`) });
        } catch (err) {
          await ctx.reply(`❌ ${toAppError(err).userMessage}`);
        }
        return;
      }

      default:
        ctx.session.step = undefined;
        await renderMainMenu(ctx);
    }
  });

  // CSV documents uploaded by an admin.
  bot.on('message:document', async (ctx) => {
    const step = ctx.session.step;
    const doc = ctx.message.document;
    if (!step || step.type !== 'admin_csv_import') {
      await ctx.reply('ℹ️ Upload a CSV only while an import is in progress (☎️ Numbers → 📄 CSV import).');
      return;
    }
    if (doc.file_size && doc.file_size > 2_000_000) {
      await ctx.reply('❌ File too large (max 2 MB). Please split it.');
      return;
    }
    try {
      const file = await ctx.api.getFile(doc.file_id);
      if (!file.file_path) throw new Error('Telegram did not return a file path');
      const url = `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
      const res = await fetch(url);
      const csvText = await res.text();
      await handleNumberCsvInput(ctx, csvText, doc.file_name);
    } catch (err) {
      ctx.session.step = undefined;
      await ctx.reply(`❌ Could not read the file: ${(err as Error).message}`);
    }
  });

  // ---------------------------------------------------------------------------
  // 6. error boundary
  // ---------------------------------------------------------------------------
  bot.catch(async (err) => {
    const ctx = err.ctx;
    const e = err.error;
    metrics.counters.telegramErrors.inc(1, { type: e instanceof GrammyError ? 'api' : e instanceof HttpError ? 'http' : 'handler' });

    const requestId = ctx.state?.requestId;
    if (e instanceof GrammyError) {
      // Deleted message, message not modified, etc. are routine; log quietly.
      const routine = /message is not modified|message to edit not found|query is too old|chat not found/i.test(e.description);
      if (routine) {
        logger.debug({ description: e.description, requestId }, 'telegram api notice');
        return;
      }
      logger.error({ description: e.description, error_code: e.error_code, requestId }, 'telegram api error');
    } else if (e instanceof HttpError) {
      logger.error({ err: e.message, requestId }, 'telegram network error');
    } else {
      logger.error({ err: e instanceof Error ? e.stack : String(e), requestId }, 'unhandled bot error');
    }

    const appError = toAppError(e);
    const message =
      appError.code === 'INTERNAL'
        ? '⚠️ Something went wrong on our side. The incident was logged. Please try again.'
        : `⚠️ ${appError.userMessage}`;

    try {
      if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: message.slice(0, 190), show_alert: true });
      else await ctx.reply(message, { reply_markup: backToMenuKeyboard(ctx.state?.isAdmin ?? false) });
    } catch {
      /* the chat may be gone; nothing more we can do */
    }
  });

  // Housekeeping for old sessions (once per start).
  void purgeOldSessions(30).catch(() => undefined);

  return bot;
}

/**
 * Starts the bot in webhook or long-polling mode.
 *
 * Webhook mode is recommended in production: it is faster, survives restarts
 * without losing updates, and the secret token is verified on every request
 * (spec §27 "Telegram callback validation").
 */
export async function startBot(bot: AppBot): Promise<{ mode: 'webhook' | 'polling' }> {
  // Publish the command list so Telegram shows a menu button inside the chat.
  // Commands a user may not use are still listed: /admin answers with a clear
  // refusal for non-admins, which is friendlier than a hidden command.
  await bot.api
    .setMyCommands([
      { command: 'start', description: 'Start or restart registration' },
      { command: 'menu', description: 'Main menu' },
      { command: 'help', description: 'How this bot works' },
      { command: 'cancel', description: 'Cancel the current step' },
    ])
    .catch((err) => logger.warn({ err: (err as Error).message }, 'could not publish the bot command list'));

  if (env.TELEGRAM_WEBHOOK_URL) {
    if (!env.TELEGRAM_WEBHOOK_SECRET) {
      throw new Error('TELEGRAM_WEBHOOK_URL is set but TELEGRAM_WEBHOOK_SECRET is empty; refusing to run an unauthenticated webhook');
    }
    await bot.api.setWebhook(`${env.TELEGRAM_WEBHOOK_URL}/telegram/webhook`, {
      secret_token: env.TELEGRAM_WEBHOOK_SECRET,
      drop_pending_updates: false,
      allowed_updates: ['message', 'callback_query'],
    });
    const me = await bot.api.getMe();
    logger.info({ username: me.username, mode: 'webhook' }, 'telegram bot webhook configured');
    return { mode: 'webhook' };
  }

  await bot.api.deleteWebhook({ drop_pending_updates: false }).catch(() => undefined);
  // `bot.start()` rejects if polling cannot continue (revoked token, network
  // outage). Catch it explicitly: without this a revoked token surfaces as an
  // unhandled rejection instead of an actionable log line, and the operators
  // get no hint of why the bot went quiet.
  void bot
    .start({
      allowed_updates: ['message', 'callback_query'],
      onStart: (me) => logger.info({ username: me.username, mode: 'polling' }, 'telegram bot started (long polling)'),
    })
    .catch((err) => {
      logger.error(
        { err: (err as Error).message },
        'telegram long polling stopped - check TELEGRAM_BOT_TOKEN (a revoked token returns 401: Unauthorized)',
      );
    });
  return { mode: 'polling' };
}

export { AppError };
