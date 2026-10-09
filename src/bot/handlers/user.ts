import { InlineKeyboard } from 'grammy';
import { env } from '../../config/env.js';
import { AppError, toAppError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { formatDate, formatDateTime, formatDuration } from '../../lib/time.js';
import type { BotContext } from '../context.js';
import {
  CB,
  backToMenuKeyboard,
  callsKeyboard,
  confirmKeyboard,
  countryKeyboard,
  depositMethodKeyboard,
  insufficientFundsKeyboard,
  mainMenuKeyboard,
  myNumbersKeyboard,
  numberActionKeyboard,
  referralKeyboard,
  serviceKeyboard,
  sipInfoKeyboard,
  numberConfirmKeyboard,
  walletKeyboard,
  withBack,
} from '../keyboards.js';
import { checkPlanAllowsNumber, getCountry, listOfferCountries, listOfferServices } from '../../services/catalog.service.js';
import { assignNumber, releaseNumber, suspendNumber, unsuspendNumber } from '../../services/assignment.service.js';
import { listNumbersForUser, getNumberById, countNumbersForUser } from '../../services/inventory.service.js';
import { getSipAccountByUser, revealCredentials, rotateSipPassword, sipEndpointConfig } from '../../services/extension.service.js';
import { getLiveCallsForUser, getUserCallHistory } from '../../services/call.service.js';
import { getReferralStats, listReferralsForUser } from '../../services/referral.service.js';
import { enqueueNotification } from '../../services/notification.service.js';
import { getBool, getNumber as getSettingNumber } from '../../services/settings.service.js';
import { writeAudit } from '../../services/audit.service.js';
import { evaluateReferralQualification } from '../../services/referral.service.js';
import { formatUsd, getWallet, listWalletTransactions } from '../../services/wallet.service.js';
import { DEPOSIT_MAX_CENTS, DEPOSIT_MIN_CENTS, cancelDepositRequest, createDepositRequest, pendingDepositForUser, parseDepositAmountCents } from '../../services/deposit.service.js';
import { getPaymentMethod, listActivePaymentMethods } from '../../services/payment-method.service.js';

/**
 * End-user screens (spec §7 – §23).
 *
 * Every screen is reachable with buttons only (spec §33). Text input is used
 * solely where a keyboard cannot express the value: the support message and the
 * admin's multi-line CSV paste.
 */

// -----------------------------------------------------------------------------
// Main menu
// -----------------------------------------------------------------------------

export async function renderMainMenu(ctx: BotContext, opts: { edit?: boolean } = {}): Promise<void> {
  const user = ctx.state.user;
  if (!user) {
    await ctx.reply('Please send /start first.');
    return;
  }

  const numbers = await listNumbersForUser(user.id);
  // No plans are ever shown in the bot (operator decision 2026-10-08): what a
  // user sees every time is their wallet balance, which is what pays for paid
  // countries now.
  const wallet = await getWallet(user.id);
  const balanceLabel = formatUsd(wallet.balance_cents);

  // The SIP ID is the user's own SIP account (sip_accounts), not a number they
  // happen to hold - it must be visible as soon as the account is provisioned,
  // Numbers = 0 included (reported live: approved user, menu showed "SIP ID: —").
  const sip = await getSipAccountByUser(user.id);
  const sipId = sip?.status === 'ACTIVE' || (sip?.status === 'PROVISIONING' && sip.extension)
    ? sip.extension
    : (numbers.find((n) => n.sip_extension)?.sip_extension ?? '—');

  const text = [
    '🏠 <b>Main Menu</b>',
    '',
    `👤 User: ${user.username ? `@${user.username}` : (user.display_name ?? user.telegram_id)}`,
    `🔑 SIP ID: <code>${sipId}</code>`,
    `📅 Expires: ${formatDate(user.expires_at)}`,
    `💰 Balance: <b>${balanceLabel}</b>`,
    `📋 Numbers: ${numbers.length}`,
    '',
    'Choose an action below.',
  ].join('\n');

  const keyboard = mainMenuKeyboard(ctx.state.isAdmin);

  if (opts.edit) {
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard }).catch(async () => {
      await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
    });
    return;
  }
  await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
}

export async function handleMainMenu(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  await renderMainMenu(ctx, { edit: true });
}

// -----------------------------------------------------------------------------
// Get Number flow (spec §8 – §12)
// -----------------------------------------------------------------------------

export async function handleGetNumber(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const user = ctx.state.user;
  if (!user) return;

  // No "release a number first" dead end: when the plan's allowance is already
  // used up, taking a new number replaces the oldest one automatically (see
  // assignNumber(..., replaceOldest) and the confirmation screen below).
  const countries = await listOfferCountries({ planId: user.plan_id });
  if (countries.length === 0) {
    await ctx.editMessageText(
      ['🌍 <b>Select Country</b>', '', '😔 No numbers are available right now.', '', 'Please try again later — our team adds inventory continuously.'].join('\n'),
      { parse_mode: 'HTML', reply_markup: backToMenuKeyboard(ctx.state.isAdmin) },
    );
    return;
  }

  await ctx.editMessageText(['🌍 <b>Select Country</b>', '', 'Availability is shown next to each country.'].join('\n'), {
    parse_mode: 'HTML',
    reply_markup: countryKeyboard(countries, 0),
  });
}

export async function handleCountryPages(ctx: BotContext, page: number): Promise<void> {
  const user = ctx.state.user;
  if (!user) return;
  await ctx.answerCallbackQuery().catch(() => undefined);
  const countries = await listOfferCountries({ planId: user.plan_id });
  await ctx.editMessageText('🌍 <b>Select Country</b>', { parse_mode: 'HTML', reply_markup: countryKeyboard(countries, page) }).catch(() => undefined);
}

export async function handleCountryPick(ctx: BotContext, countryId: string): Promise<void> {
  const user = ctx.state.user;
  if (!user) return;
  await ctx.answerCallbackQuery().catch(() => undefined);

  const services = await listOfferServices({ countryId, planId: user.plan_id });
  if (services.length === 0) {
    await ctx.answerCallbackQuery('No services available for this country.').catch(() => undefined);
    return;
  }
  // The country travels in the session, not in the button: country+service+plan
  // ids together are longer than Telegram's 64-byte callback_data limit.
  ctx.session.offerCountryId = countryId;

  await ctx.editMessageText(['📱 <b>Select Service</b>', '', 'Availability is shown next to each service.'].join('\n'), {
    parse_mode: 'HTML',
    reply_markup: serviceKeyboard(services),
  });
}

export async function handleServicePick(ctx: BotContext, serviceId: string): Promise<void> {
  const user = ctx.state.user;
  if (!user) return;
  await ctx.answerCallbackQuery().catch(() => undefined);

  const countryId = ctx.session.offerCountryId;
  if (!countryId) {
    // The user came back to an old message (or a different device/session).
    await ctx.answerCallbackQuery('Please choose a country again.').catch(() => undefined);
    await handleGetNumber(ctx);
    return;
  }

  const services = await listOfferServices({ countryId, planId: user.plan_id });
  const service = services.find((s) => s.id === serviceId);
  if (!service) {
    await ctx.answerCallbackQuery('That service is no longer available.').catch(() => undefined);
    return;
  }

  const planType: 'FREE' | 'PREMIUM' = service.requires_premium ? 'PREMIUM' : 'FREE';

  // Default UX (per product decision): tapping a service assigns the number
  // right away - country -> service -> number. The administrator can switch the
  // extra confirmation screen back on with `numbers.require_confirmation = 1`
  // in the admin settings (nothing about the flow is hard-coded).
  const confirm = await getBool('numbers.require_confirmation', false);
  if (!confirm) {
    await executeAssignment(ctx, countryId, serviceId, planType, { edit: true });
    return;
  }

  const country = await getCountry(countryId);

  // Does taking this number replace one the user already holds? Say so up front
  // - it is automatic, but it must never be a surprise.
  const held = await listNumbersForUser(user.id);
  const limit = await planLimitFor(user);
  const willReplace = held.length >= limit ? held.slice(held.length - (held.length - limit + 1)) : [];

  const text = [
    '☎️ <b>Assign a number</b>',
    '',
    country ? `🌍 Country: ${country.flag ?? ''} ${country.name}` : '',
    `📱 Service: ${service.icon ?? ''} ${service.name}`,
    `📦 Available: ${service.available_count}`,
    `💎 Type: ${planType === 'PREMIUM' ? 'Premium' : 'Free'}`,
    service.price_cents ? `💶 Price: ${(service.price_cents / 100).toFixed(2)} ${service.currency}/month` : '💶 Price: included in your plan',
    '',
    ...(willReplace.length > 0
      ? [
          `♻️ Your plan allows <b>${limit}</b> number(s) and you already hold ${held.length}. Taking this number removes <code>${willReplace
            .map((n) => n.phone_number)
            .join(', ')}</code> from your account automatically — no need to release it yourself.`,
        ]
      : []),
    '',
    `Tap <b>✅ Assign number</b> and the next free number will be reserved for you and routed to your SIP account.`,
  ]
    .filter(Boolean)
    .join('\n');

  await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: numberConfirmKeyboard(countryId, serviceId, planType) });
}

export async function handleConfirmGetNumber(ctx: BotContext, serviceId: string, planType: 'FREE' | 'PREMIUM'): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const countryId = ctx.session.offerCountryId;
  if (!countryId) {
    await ctx.answerCallbackQuery('Please choose a country again.').catch(() => undefined);
    await handleGetNumber(ctx);
    return;
  }
  await executeAssignment(ctx, countryId, serviceId, planType, { edit: true });
}

async function executeAssignment(
  ctx: BotContext,
  countryId: string,
  serviceId: string,
  planType: 'FREE' | 'PREMIUM',
  opts: { edit?: boolean } = {},
): Promise<void> {
  const user = ctx.state.user;
  if (!user) return;

  const send = async (text: string, keyboard: InlineKeyboard) => {
    if (opts.edit) await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard }));
    else await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
  };

  // A keyboard even on the transient step (the walker's "every screen has a way
  // out" contract, and it leaves visible the next step while the route is built):
  // the creación usually finishes in a second and this message becomes the
  // receipt; the corroborated progress line keeps the SIP-info shortcut handy.
  await send(
    '⏳ Reserving a number and configuring the route…',
    new InlineKeyboard().text('ℹ️ SIP Info', CB.SIP_INFO).text('🏠 Main Menu', CB.MAIN_MENU),
  );

  try {
    const result = await assignNumber({
      userId: user.id,
      countryId,
      serviceId,
      planType,
      // A full plan is not a dead end: the oldest number the user holds is
      // released automatically once the new one is live.
      replaceOldest: true,
      source: ctx.state.isAdmin ? 'ADMIN' : 'USER',
      actorId: user.id,
      actorTelegramId: ctx.from?.id ?? null,
      requestId: ctx.state.requestId,
    });

    const number = await getNumberById(result.numberId);
    const text = [
      '✅ <b>Number assigned</b>',
      '',
      `📞 <code>${result.phoneNumber}</code>`,
      number ? `🌍 ${number.country_flag ?? ''} ${number.country_name}` : '',
      number ? `📱 ${number.service_icon ?? ''} ${number.service_name}` : '',
      `🔑 Routed to SIP: <code>${result.extension}</code>`,
      result.chargedCents && result.chargedCents > 0
        ? `💳 Paid ${formatUsd(result.chargedCents)} — new balance: ${formatUsd(result.balanceAfterCents ?? 0)}`
        : '',
      '',
      result.replacedNumbers && result.replacedNumbers.length > 0
        ? `♻️ Replaced <code>${result.replacedNumbers.join(', ')}</code> — it was removed from your account automatically and returned to inventory.`
        : '',
      'Incoming calls to this number now ring your SIP account.',
      result.pbxWarning ? `\nℹ️ ${result.pbxWarning}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    await send(text, new InlineKeyboard().text('📋 My Numbers', CB.MY_NUMBERS).text('ℹ️ SIP Info', CB.SIP_INFO).row().text('🏠 Main Menu', CB.MAIN_MENU));

    // Referral qualification: a first successful assignment is the default
    // "qualified" event (spec §23).
    await evaluateReferralQualification(user.id, 'FIRST_NUMBER_ASSIGNED').catch((err) =>
      logger.warn({ err: (err as Error).message }, 'referral evaluation failed'),
    );
  } catch (err) {
    const appError = toAppError(err);
    logger.warn({ code: appError.code, userId: user.id }, 'assignment failed');

    if (appError.code === 'INSUFFICIENT_FUNDS') {
      const amount = appError.details?.amountCents ?? appError.details?.requiredCents;
      const balance = appError.details?.balanceCents;
      const lines = [
        '💸 <b>Not enough balance</b>',
        '',
        'This is a paid number and your balance is too low.',
        typeof amount === 'number' ? `Needed: <b>${formatUsd(amount as number)}</b>` : '',
        typeof balance === 'number' ? `Your balance: ${formatUsd(balance as number)}` : '',
        '',
        'Nothing was charged and no number was reserved. Deposit to top up, then try again.',
      ];
      await send(lines.filter(Boolean).join('\n'), insufficientFundsKeyboard());
      return;
    }

    const message =
      appError.code === 'NO_INVENTORY'
        ? ['😔 <b>No numbers available</b>', '', appError.userMessage, '', 'Please try another country/service or try again later.'].join('\n')
        : appError.code === 'PBX_UNAVAILABLE' || appError.code === 'PBX_REJECTED'
          ? ['❌ <b>Number could not be assigned</b>', '', appError.userMessage, '', 'Nothing was charged and no number was attached to your account.'].join('\n')
          : ['❌ <b>Could not assign a number</b>', '', appError.userMessage].join('\n');

    await send(message, backToMenuKeyboard(ctx.state.isAdmin));
    await writeAudit({
      actorId: user.id,
      actorTelegramId: ctx.from?.id ?? null,
      actorType: 'USER',
      action: 'NUMBER_ASSIGNMENT_FAILED',
      result: 'FAILURE',
      targetType: 'number',
      reason: appError.code,
      metadata: { countryId, serviceId, planType },
      requestId: ctx.state.requestId,
    });
  }
}

async function planLimitFor(user: { plan_id: string | null; id: string }): Promise<number> {
  const check = await checkPlanAllowsNumber({
    planId: user.plan_id,
    userId: user.id,
    countryId: '00000000-0000-0000-0000-000000000000',
    serviceId: '00000000-0000-0000-0000-000000000000',
    planType: 'FREE',
    currentCount: 0,
  });
  if (check.allowed) {
    // The plan row is the source of truth; read its limit directly.
    const { getPlan, getDefaultPlan } = await import('../../services/catalog.service.js');
    const plan = user.plan_id ? await getPlan(user.plan_id) : await getDefaultPlan();
    return plan?.max_numbers ?? 1;
  }
  const { getPlan, getDefaultPlan } = await import('../../services/catalog.service.js');
  const plan = user.plan_id ? await getPlan(user.plan_id) : await getDefaultPlan();
  return plan?.max_numbers ?? 1;
}

// -----------------------------------------------------------------------------
// My Numbers (spec §7, §16, §17)
// -----------------------------------------------------------------------------

export async function handleMyNumbers(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const user = ctx.state.user;
  if (!user) return;

  const numbers = await listNumbersForUser(user.id);
  const allowRelease = await getBool('numbers.allow_user_release', true);

  if (numbers.length === 0) {
    await ctx.editMessageText(
      ['📋 <b>My Numbers</b>', '', 'You have no numbers yet.'].join('\n'),
      { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('☎️ Get Number', CB.GET_NUMBER).row().text('🏠 Main Menu', CB.MAIN_MENU) },
    );
    return;
  }

  const lines = [
    '📋 <b>My Numbers</b>',
    '',
    ...numbers.map((n) => {
      const status = n.status === 'SUSPENDED' ? '⚠️ suspended' : n.status === 'ASSIGNED' ? '🟢 active' : '⏳ pending';
      return `📞 <code>${n.phone_number}</code> — ${status}\n   ${n.country_flag ?? ''} ${n.country_name} · ${n.service_icon ?? ''} ${n.service_name}${n.expiration_date ? ` · ⏳ ${formatDate(n.expiration_date)}` : ''}`;
    }),
    '',
    'Tap a number for details.',
  ];

  await ctx.editMessageText(lines.join('\n'), { parse_mode: 'HTML', reply_markup: myNumbersKeyboard(numbers, allowRelease) });
}

export async function handleNumberInfo(ctx: BotContext, numberId: string): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const user = ctx.state.user;
  if (!user) return;

  const number = await getNumberById(numberId);
  if (!number) {
    await ctx.editMessageText('❌ Number not found.', { reply_markup: backToMenuKeyboard(ctx.state.isAdmin) }).catch(() => undefined);
    return;
  }
  if (number.assigned_user_id && number.assigned_user_id !== user.id && !ctx.state.isAdmin) {
    await ctx.answerCallbackQuery('This number belongs to another user.').catch(() => undefined);
    return;
  }

  const live = await getLiveCallsForUser(user.id);
  const activeCall = live.find((c) => c.did && number.phone_number.includes(c.did.replace(/\D/g, '')));

  const text = [
    '📞 <b>Number details</b>',
    '',
    `Number: <code>${number.phone_number}</code>`,
    `Status: ${number.status}`,
    `Country: ${number.country_flag ?? ''} ${number.country_name}`,
    `Service: ${number.service_icon ?? ''} ${number.service_name}`,
    `Type: ${number.plan_type}`,
    `SIP ID: <code>${number.sip_extension ?? '—'}</code>`,
    number.expiration_date ? `Expires: ${formatDate(number.expiration_date)}` : 'Expires: —',
    number.last_route_sync_at ? `Route synced: ${formatDateTime(number.last_route_sync_at)}` : '',
    activeCall ? `\n🔴 Live call: ${activeCall.state} from ${activeCall.caller}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const allowRelease = await getBool('numbers.allow_user_release', true);
  await ctx.editMessageText(text, {
    parse_mode: 'HTML',
    reply_markup: numberActionKeyboard(numberId, { canRelease: allowRelease && number.assigned_user_id === user.id, canSuspend: false }),
  });
}

export async function handleReleasePick(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const user = ctx.state.user;
  if (!user) return;
  const numbers = await listNumbersForUser(user.id);

  const kb = new InlineKeyboard();
  for (const n of numbers) kb.text(`♻️ ${n.phone_number}`, `n:relok:${n.id}`).row();
  kb.text('⬅️ My Numbers', CB.MY_NUMBERS);

  await ctx.editMessageText(
    ['♻️ <b>Release a number</b>', '', 'Releasing returns the number to inventory and removes its inbound route.', '', 'Choose the number to release:'].join('\n'),
    { parse_mode: 'HTML', reply_markup: kb },
  );
}

export async function handleReleaseConfirmPrompt(ctx: BotContext, numberId: string): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const number = await getNumberById(numberId);
  if (!number) return;

  await ctx.editMessageText(
    [
      '⚠️ <b>Are you sure?</b>',
      '',
      `You are about to release <code>${number.phone_number}</code>.`,
      '',
      '• Incoming calls will stop working immediately.',
      '• The number goes back to the shared inventory.',
      '• You can request a new number afterwards, but not necessarily this one.',
    ].join('\n'),
    { parse_mode: 'HTML', reply_markup: confirmKeyboard(`n:relyes:${numberId}`, `n:info:${numberId}`, '✅ Yes, release', '❌ Cancel') },
  );
}

export async function handleReleaseExecute(ctx: BotContext, numberId: string): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const user = ctx.state.user;
  if (!user) return;

  const number = await getNumberById(numberId);
  if (!number) return;

  try {
    await releaseNumber(numberId, {
      actorId: user.id,
      actorTelegramId: ctx.from?.id ?? null,
      actorType: 'USER',
      reason: 'released by user',
      requestId: ctx.state.requestId,
    });
    await ctx.editMessageText(
      ['✅ <b>Number released</b>', '', `<code>${number.phone_number}</code> has been returned to inventory and its route was removed.`].join('\n'),
      { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('📋 My Numbers', CB.MY_NUMBERS).row().text('☎️ Get Number', CB.GET_NUMBER).row().text('🏠 Main Menu', CB.MAIN_MENU) },
    );
  } catch (err) {
    const appError = toAppError(err);
    await ctx.editMessageText(['❌ <b>Could not release the number</b>', '', appError.userMessage].join('\n'), {
      parse_mode: 'HTML',
      reply_markup: backToMenuKeyboard(ctx.state.isAdmin),
    });
  }
}

// -----------------------------------------------------------------------------
// SIP Information (spec §18)
// -----------------------------------------------------------------------------

export async function handleSipInfo(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const user = ctx.state.user;
  if (!user) return;

  const account = await getSipAccountByUser(user.id);
  const endpoint = sipEndpointConfig();

  if (!account) {
    await ctx.editMessageText(
      ['ℹ️ <b>SIP Information</b>', '', '⏳ Your SIP account is not ready yet.', '', 'If this persists, please contact support.'].join('\n'),
      { parse_mode: 'HTML', reply_markup: backToMenuKeyboard(ctx.state.isAdmin) },
    );
    return;
  }

  const credentials = await revealCredentials(account.id, { ownerUserId: user.id });

  const text = [
    'ℹ️ <b>SIP Information</b>',
    '',
    `🔑 SIP ID: <code>${credentials.extension}</code>`,
    `🔒 Password: <code>${credentials.password}</code>`,
    '',
    `🌐 Server: <code>${credentials.server}</code>`,
    `🔌 Port: <code>${credentials.port}</code>`,
    `📡 Transport: ${credentials.transport}`,
    `🏷 Domain: <code>${credentials.domain}</code>`,
    '',
    `<i>Settings for your softphone (Zoiper, Linphone, Grandstream, Yealink…):</i>`,
    `<i>Account/username:</i> <code>${credentials.extension}</code>`,
    `<i>Auth ID:</i> <code>${credentials.extension}</code>`,
    `<i>Password:</i> as above`,
    '',
    '⚠️ Never share these credentials — anyone with them can use your line.',
  ].join('\n');

  const hasNumbers = (await countNumbersForUser(user.id)) > 0;
  await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: sipInfoKeyboard(hasNumbers) });
}

export async function handleSipPlain(ctx: BotContext): Promise<void> {
  const user = ctx.state.user;
  if (!user) return;
  await ctx.answerCallbackQuery().catch(() => undefined);

  const account = await getSipAccountByUser(user.id);
  if (!account) {
    await ctx.answerCallbackQuery('No SIP account yet.').catch(() => undefined);
    return;
  }
  const c = await revealCredentials(account.id, { ownerUserId: user.id });
  // Plain, copy-friendly block (no HTML) so users can paste it into any client.
  await ctx.reply(
    [
      'Copy these into your softphone:',
      '',
      `SIP ID: ${c.extension}`,
      `Password: ${c.password}`,
      `Server: ${c.server}`,
      `Port: ${c.port}`,
      `Transport: ${c.transport}`,
      `Domain: ${c.domain}`,
    ].join('\n'),
  );
}

export async function handleSipRotate(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const user = ctx.state.user;
  if (!user) return;

  await ctx.editMessageText(
    ['🔄 <b>Rotate SIP password</b>', '', 'Your current password will stop working immediately.', 'You must update it in your softphone.'].join('\n'),
    { parse_mode: 'HTML', reply_markup: confirmKeyboard('s:rotok', CB.SIP_INFO, '✅ Rotate now', '❌ Cancel') },
  );
}

export async function handleSipRotateConfirm(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const user = ctx.state.user;
  if (!user) return;

  await ctx.editMessageText('⏳ Rotating your SIP password…', { reply_markup: new InlineKeyboard() });
  try {
    const credentials = await rotateSipPassword(user.id, { requestId: ctx.state.requestId });
    await ctx.editMessageText(
      [
        '✅ <b>Password rotated</b>',
        '',
        `🔑 SIP ID: <code>${credentials.extension}</code>`,
        `🔒 New password: <code>${credentials.password}</code>`,
        '',
        'Update it in your softphone now.',
      ].join('\n'),
      { parse_mode: 'HTML', reply_markup: backToMenuKeyboard(ctx.state.isAdmin) },
    );
  } catch (err) {
    await ctx.editMessageText(['❌ <b>Rotation failed</b>', '', toAppError(err).userMessage].join('\n'), {
      parse_mode: 'HTML',
      reply_markup: backToMenuKeyboard(ctx.state.isAdmin),
    });
  }
}

// -----------------------------------------------------------------------------
// My Calls (spec §21, §20)
// -----------------------------------------------------------------------------

export async function handleMyCalls(ctx: BotContext, page = 0): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const user = ctx.state.user;
  if (!user) return;

  const pageSize = await getSettingNumber('calls.history_page_size', 10);
  const [{ rows, total }, live] = await Promise.all([getUserCallHistory(user.id, { limit: pageSize, offset: page * pageSize }), getLiveCallsForUser(user.id)]);

  const lines: string[] = ['📞 <b>My Calls</b>'];

  if (live.length > 0) {
    lines.push('', '🔴 <b>Active now</b>');
    for (const call of live.slice(0, 3)) {
      lines.push(`• ${call.state} · from ${call.caller || 'unknown'} · ${formatDuration(call.durationSeconds)}`);
    }
  }

  lines.push('', '🗂 <b>Recent</b>');
  if (rows.length === 0) {
    lines.push('No calls recorded yet.');
  } else {
    for (const call of rows) {
      const icon = call.disposition === 'ANSWERED' ? '✅' : call.disposition === 'NO ANSWER' ? '📵' : '❌';
      const direction = call.direction === 'INBOUND' ? '⬅️' : call.direction === 'OUTBOUND' ? '➡️' : '🔄';
      lines.push(
        `${icon} ${direction} <code>${call.src ?? '—'}</code> → <code>${call.dst ?? '—'}</code>`,
        `    ${formatDateTime(call.calldate)} · ${formatDuration(call.billsec)} · ${call.disposition ?? '—'}`,
      );
    }
  }

  lines.push('', `<i>Calls you can see are only the ones routed to your numbers (${total} total).</i>`);

  await ctx.editMessageText(lines.join('\n'), { parse_mode: 'HTML', reply_markup: callsKeyboard(page, total, pageSize) });
}

export async function handleMyCallsPage(ctx: BotContext, page: number): Promise<void> {
  await handleMyCalls(ctx, page);
}

// -----------------------------------------------------------------------------
// Referral (spec §23)
// -----------------------------------------------------------------------------

export async function handleReferral(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const user = ctx.state.user;
  if (!user) return;

  const botUsername = ctx.me.username;
  const stats = await getReferralStats(user.id, botUsername);

  if (!stats.enabled) {
    await ctx.editMessageText('💤 The referral programme is currently disabled.', { reply_markup: backToMenuKeyboard(ctx.state.isAdmin) });
    return;
  }

  const money = (cents: number) => `${(cents / 100).toFixed(2)} ${stats.currency}`;
  const ruleText: Record<string, string> = {
    SIGNUP: 'when someone registers',
    USER_APPROVED: 'when a referral is approved',
    FIRST_NUMBER_ASSIGNED: 'when a referral gets their first number',
    PLAN_PURCHASED: 'when a referral buys a plan',
  };

  const text = [
    '💰 <b>Referral programme</b>',
    '',
    `🔗 Your link:`,
    `<code>${stats.link ?? '—'}</code>`,
    '',
    `💶 Commission: ${stats.commissionType === 'PERCENTAGE' ? `${stats.commissionValue}% of the plan price` : `${stats.commissionValue} ${stats.currency} per referral`}`,
    `✅ Qualified: ${ruleText[stats.qualificationRule] ?? stats.qualificationRule}`,
    '',
    `👥 Invited: <b>${stats.total}</b>`,
    `✅ Qualified: <b>${stats.qualified}</b>`,
    `💸 Earned (pending): <b>${money(stats.pendingCents)}</b>`,
    `🏦 Paid: <b>${money(stats.paidCents)}</b>`,
  ].join('\n');

  await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: referralKeyboard(stats.link) });
}

export async function handleReferralList(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const user = ctx.state.user;
  if (!user) return;

  const rows = await listReferralsForUser(user.id, 15);
  const lines = ['👥 <b>My referrals</b>', ''];
  if (rows.length === 0) {
    lines.push('No referrals yet. Share your link to get started!');
  } else {
    for (const r of rows) {
      const icon = r.status === 'PENDING' ? '⏳' : r.status === 'QUALIFIED' ? '✅' : r.status === 'PAID' ? '💸' : '🚫';
      lines.push(`${icon} ${r.username ? `@${r.username}` : 'user'} · ${formatDate(r.created_at)} · ${r.status}`);
    }
  }

  await ctx.editMessageText(lines.join('\n'), { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('⬅️ Referral', CB.REFERRAL).row().text('🏠 Main Menu', CB.MAIN_MENU) });
}

// -----------------------------------------------------------------------------
// Support (spec §7)
// -----------------------------------------------------------------------------

export async function handleSupport(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const user = ctx.state.user;

  ctx.session.step = { type: 'support_message' };
  await ctx.editMessageText(
    [
      '🆘 <b>Support</b>',
      '',
      'Send your message and the team will reply here.',
      '',
      user ? `Your account: <code>${user.username ?? user.telegram_id}</code>` : '',
      env.SUPPORT_USERNAME ? `Direct contact: @${env.SUPPORT_USERNAME}` : '',
      '',
      'Type your message now (or /cancel).',
    ]
      .filter(Boolean)
      .join('\n'),
    { parse_mode: 'HTML', reply_markup: withBack(new InlineKeyboard().text('❌ Cancel', 'm:cancel')) },
  );
}

export async function handleSupportMessage(ctx: BotContext, text: string): Promise<void> {
  const user = ctx.state.user;
  ctx.session.step = undefined;

  await enqueueNotification({
    userId: user?.id ?? null,
    telegramId: ctx.from?.id ?? null,
    kind: 'SUPPORT_REPLY',
    payload: { text: '✅ Your message has been received. The team will reply shortly.' },
    dedupeKey: `support-ack:${ctx.from?.id}:${Date.now()}`,
  });

  const { enqueueAdminNotification } = await import('../../services/notification.service.js');
  await enqueueAdminNotification(
    'ADMIN_ALERT',
    {
      title: 'Support request',
      message: `From ${user?.username ? `@${user.username}` : ctx.from?.id}:\n\n${text.slice(0, 800)}`,
    },
    `support:${ctx.from?.id}:${Date.now()}`,
  );

  await ctx.reply(
    ['✅ <b>Message sent</b>', '', 'Our team will reply here as soon as possible.'].join('\n'),
    { parse_mode: 'HTML', reply_markup: backToMenuKeyboard(ctx.state.isAdmin) },
  );
}

// -----------------------------------------------------------------------------
// Wallet & deposits (operator decision 2026-10-08)
// -----------------------------------------------------------------------------
// Money flow: a user sees Balance on the main menu, taps 💰 Balance for the
// wallet home, and 💳 Deposit starts a manual-approval deposit. Amount and an
// optional payment reference are typed; the admin approves/rejects from a ✅❌
// notification - exactly the same pattern as user approvals.

export async function handleWallet(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const user = ctx.state.user;
  if (!user) return;

  const [wallet, pending, txs] = await Promise.all([
    getWallet(user.id),
    pendingDepositForUser(user.id),
    listWalletTransactions(user.id, 6),
  ]);

  const lines = [
    '💰 <b>Your Wallet</b>',
    '',
    `Balance: <b>${formatUsd(wallet.balance_cents)}</b>`,
    '',
    pending ? `⏳ Deposit of <b>${formatUsd(pending.amount_cents)}</b> is awaiting approval (since ${formatDateTime(pending.requested_at)}).` : '',
    'Recent activity:',
  ].filter(Boolean);

  if (txs.length === 0) {
    lines.push('<i>No transactions yet.</i>');
  } else {
    for (const tx of txs) {
      const sign = tx.amount_cents >= 0 ? '+' : '−';
      const icon =
        tx.kind === 'DEPOSIT' ? '💳' : tx.kind === 'REFUND' ? '↩️' : tx.kind === 'ADMIN_ADJUSTMENT' ? '🛠' : '☎️';
      lines.push(`${icon} ${sign}${formatUsd(Math.abs(tx.amount_cents)).replace('$', '$')} → ${formatUsd(tx.balance_after_cents)} <i>· ${tx.kind.toLowerCase().replace('_', ' ')}</i>`);
    }
  }
  lines.push('', 'Paid countries are charged from this balance - paid numbers are marked 💎 in the country list, 🆓 ones are free.');

  await ctx.editMessageText(lines.join('\n'), { parse_mode: 'HTML', reply_markup: walletKeyboard(Boolean(pending)) });
}

/** 💳 Deposit step 1: choose the payment method the admin has configured. */
export async function handleDepositStart(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const user = ctx.state.user;
  if (!user) return;

  const pending = await pendingDepositForUser(user.id);
  if (pending) {
    await ctx.editMessageText(
      ['⏳ <b>Deposit already pending</b>', '', `Your request for <b>${formatUsd(pending.amount_cents)}</b> is waiting for approval.`, '', 'You can have only one pending deposit at a time - wait for it, or cancel it from the wallet screen.'].join('\n'),
      { parse_mode: 'HTML', reply_markup: walletKeyboard(true) },
    );
    return;
  }

  const methods = await listActivePaymentMethods();
  if (methods.length === 0) {
    await ctx.editMessageText(
      ['💳 <b>Deposit</b>', '', 'No payment methods are configured right now.', 'Please ask the support team which method you can pay with.'].join('\n'),
      { parse_mode: 'HTML', reply_markup: withBack(new InlineKeyboard().text('🆘 Support', CB.SUPPORT)) },
    );
    return;
  }

  await ctx.editMessageText(
    ['💳 <b>Deposit</b>', '', 'Choose how you want to pay:', '', 'After picking a method you will enter the amount, see the address to pay, and send the transaction ID.'].join('\n'),
    { parse_mode: 'HTML', reply_markup: depositMethodKeyboard(methods) },
  );
}

/** 💳 Deposit step 2: method chosen → ask for the amount. */
export async function handleDepositMethodPick(ctx: BotContext, methodId: string): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const method = await getPaymentMethod(methodId);
  if (!method || method.status !== 'ACTIVE') {
    await ctx.editMessageText('❌ That payment method is no longer available.', {
      reply_markup: new InlineKeyboard().text('💳 Deposit', CB.DEPOSIT).text('🏠 Main Menu', CB.MAIN_MENU),
    });
    return;
  }
  ctx.session.step = { type: 'deposit_amount', methodId: method.id };
  await ctx.editMessageText(
    [
      '💳 <b>Deposit</b>',
      '',
      `Method: <b>${method.icon ?? '💠'} ${method.name}</b>`,
      '',
      'Type the amount you want to deposit, in USD.',
      '',
      'Examples: <code>5</code>, <code>$5</code>, <code>10.50</code>',
      'Minimum $0.50 · maximum $10,000',
    ].join('\n'),
    { parse_mode: 'HTML', reply_markup: withBack(new InlineKeyboard().text('❌ Cancel', 'm:cancel')) },
  );
}

export async function handleDepositAmountInput(ctx: BotContext, text: string): Promise<void> {
  const step = ctx.session.step;
  if (step?.type !== 'deposit_amount') return;
  const method = await getPaymentMethod(step.methodId);
  if (!method || method.status !== 'ACTIVE') {
    ctx.session.step = undefined;
    await ctx.reply('❌ That payment method is no longer available - start again from 💳 Deposit.', { reply_markup: backToMenuKeyboard(ctx.state.isAdmin) });
    return;
  }
  const cents = parseDepositAmountCents(text);
  if (cents === null || cents < DEPOSIT_MIN_CENTS || cents > DEPOSIT_MAX_CENTS) {
    await ctx.reply(
      `❌ Please type a valid amount between ${formatUsd(DEPOSIT_MIN_CENTS)} and ${formatUsd(DEPOSIT_MAX_CENTS)} (e.g. <code>5</code> or <code>$10.50</code>), or /cancel.`,
      { parse_mode: 'HTML' },
    );
    return;
  }
  // Step 3: show the gateway address, then collect the transaction ID.
  ctx.session.step = { type: 'deposit_note', methodId: method.id, amountCents: cents };
  await ctx.reply(
    [
      '💳 <b>Deposit</b>',
      '',
      `Method: <b>${method.icon ?? '💠'} ${method.name}</b>`,
      `Amount: <b>${formatUsd(cents)}</b>`,
      '',
      `Send the payment to:`,
      `<code>${method.address}</code>`,
      method.instructions ?? '',
      '',
      'When you have paid, <b>send the transaction ID</b> (TXID / order number from your payment).',
      'The request goes to the admins - the money is credited as soon as they approve it.',
    ].filter(Boolean).join('\n'),
    { parse_mode: 'HTML', reply_markup: withBack(new InlineKeyboard().text('❌ Cancel', 'm:cancel')) },
  );
}

export async function handleDepositNoteInput(ctx: BotContext, text: string): Promise<void> {
  const step = ctx.session.step;
  if (step?.type !== 'deposit_note') return;
  const txid = text.trim();
  if (txid.length < 4 || txid.length > 200) {
    await ctx.reply('❌ That does not look like a transaction ID (4–200 characters). Send the TXID from your payment, or /cancel.', { parse_mode: 'HTML' });
    return;
  }
  await submitDepositRequest(ctx, step.methodId, step.amountCents, txid);
}

async function submitDepositRequest(ctx: BotContext, methodId: string, amountCents: number, txid: string): Promise<void> {
  const user = ctx.state.user;
  if (!user) return;
  ctx.session.step = undefined;
  try {
    await createDepositRequest(user.id, {
      amountCents,
      methodId,
      txid,
      telegramId: ctx.from?.id ?? 0,
      displayName: user.display_name ?? (user.username ? `@${user.username}` : String(user.telegram_id)),
    });
    const method = await getPaymentMethod(methodId);
    await ctx.reply(
      [
        '✅ <b>Deposit request submitted</b>',
        '',
        `Amount: <b>${formatUsd(amountCents)}</b>`,
        `Method: ${method ? `${method.icon ?? '💠'} ${method.name}` : '—'}`,
        `TXID: <code>${txid.slice(0, 120)}</code>`,
        '',
        '⏳ Status: <b>pending approval</b> - the admins will verify the payment and the money will land in your balance. You will get a message here.',
      ].join('\n'),
      { parse_mode: 'HTML', reply_markup: backToMenuKeyboard(ctx.state.isAdmin) },
    );
  } catch (err) {
    const appError = toAppError(err);
    if (appError.code === 'CONFLICT') {
      await ctx.reply('⏳ You already have a pending deposit - wait for the admin to approve it, or cancel it from 💰 Balance.', { reply_markup: backToMenuKeyboard(ctx.state.isAdmin) });
      return;
    }
    await ctx.reply([`❌ ${appError.userMessage}`, '', 'Please try again from 💰 Balance.'].join('\n'), { reply_markup: backToMenuKeyboard(ctx.state.isAdmin) });
  }
}

/** ❌ Cancel my own pending deposit request (nothing was credited). */
export async function handleDepositCancelPending(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const user = ctx.state.user;
  if (!user) return;
  const cancelled = await cancelDepositRequest(user.id);
  await handleWallet(ctx);
  if (cancelled) {
    await ctx.reply('❌ Pending deposit cancelled - nothing was credited.', { reply_markup: backToMenuKeyboard(ctx.state.isAdmin) });
  }
}

export async function handleCancel(ctx: BotContext): Promise<void> {
  ctx.session.step = undefined;
  await ctx.answerCallbackQuery('Cancelled').catch(() => undefined);
  await renderMainMenu(ctx, { edit: true });
}

export async function handleNoop(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
}

export { suspendNumber, unsuspendNumber, AppError };
