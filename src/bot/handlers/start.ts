import { InlineKeyboard } from 'grammy';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import type { BotContext } from '../context.js';
import { CB, backToMenuKeyboard, mainMenuKeyboard } from '../keyboards.js';
import {
  findUserForTelegram,
  recordCaptchaAttempt,
  registerUser,
  resolveRole,
  setMembershipStatus,
  upsertTelegramAccount,
} from '../../services/user.service.js';
import { enqueueAdminNotification } from '../../services/notification.service.js';
import { getBool, getNumber, getString } from '../../services/settings.service.js';
import { noteReferralClick } from '../../services/referral.service.js';
import { writeAudit } from '../../services/audit.service.js';
import { checkRequiredMembership } from '../../services/channelGate.service.js';
import { renderMainMenu } from './user.js';
import { activateStaffAccount } from './staff.js';

/** Minimal HTML escaper for chat titles shown with parse_mode HTML. */
const escapeHtml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * REGISTRATION FLOW (spec §4, §5, §33)
 * ===================================
 *
 *   /start
 *     -> (optional) forced channel membership check
 *     -> (optional) arithmetic CAPTCHA
 *     -> user row created with status PENDING
 *     -> admin receives an approval request with inline buttons
 *     -> admin approves -> SIP account provisioned -> user gets credentials
 *
 * The flow is entirely inline-keyboard driven; typed commands are supported as
 * shortcuts but never required.
 */

export async function handleStart(ctx: BotContext): Promise<void> {
  const from = ctx.from;
  if (!from) return;

  const startPayload = extractStartPayload(ctx);
  const account = await upsertTelegramAccount({
    telegramId: from.id,
    chatId: ctx.chat?.id,
    username: from.username ?? null,
    firstName: from.first_name ?? null,
    lastName: from.last_name ?? null,
    languageCode: from.language_code ?? null,
    lastUpdateId: ctx.update.update_id,
  });

  if (account.banned) {
    await ctx.reply('🚫 Your access has been suspended. Please contact support.');
    return;
  }

  // 1. Registration switch
  const registrationOpen = await getBool('bot.registration_enabled', true);
  const existing = await findUserForTelegram(from.id);
  if (!registrationOpen && !existing) {
    await ctx.reply('🔒 Registration is currently closed. Please try again later.');
    return;
  }

  // 2. Existing users skip straight to the menu.
  if (existing) {
    if (existing.status === 'ACTIVE') {
      await renderMainMenu(ctx, { edit: false });
      return;
    }
    if (existing.status === 'PENDING') {
      // An operator account is never left waiting for approval: at first boot
      // there is nobody else to approve it (src/bot/handlers/staff.ts).
      const activation = await activateStaffAccount(ctx);
      if (activation.activated) {
        await ctx.reply(
          [
            '✅ <b>Operator account activated</b>',
            '',
            activation.extension ? `🔑 SIP ID: <code>${activation.extension}</code>` : '',
            activation.provisioningError
              ? '⚠️ SIP account could not be created yet; retry from 🛠 Admin Panel → 👥 Users.'
              : 'Your number requests are ready to go.',
          ]
            .filter(Boolean)
            .join('\n'),
          { parse_mode: 'HTML', reply_markup: mainMenuKeyboard(true) },
        );
        await renderMainMenu(ctx);
        return;
      }

      // Pending means pending: no action buttons, just the waiting screen
      // (reported live with a screenshot - the full menu used to render here
      // and every button would dead-end on a PENDING user anyway).
      await sendApprovalPending(ctx, { captchaSolved: false });
      return;
    }
    if (existing.status === 'BLOCKED') {
      await ctx.reply('⛔️ Your account is blocked. Please contact support.', {
        parse_mode: 'HTML',
        reply_markup: new InlineKeyboard().url('🆘 Support', `https://t.me/${env.SUPPORT_USERNAME || 'telegram'}`),
      });
      return;
    }
  }

  // 3. Referral attribution (/start <code>).
  const referralCode = startPayload && /^[A-Za-z0-9]{4,20}$/.test(startPayload) ? startPayload.toUpperCase() : null;
  if (referralCode) await noteReferralClick(referralCode).catch(() => undefined);

  // 4. Forced channel/group membership (DB-driven: bot.required_chats). A
  //    deleted user comes back through this same gate - membership is checked
  //    live from Telegram every time, so a removal or rejoin is honoured
  //    immediately.
  const requireMembership = await getBool('bot.require_channel_membership', false);
  if (requireMembership) {
    const { ok, missing } = await checkRequiredMembership(ctx.api, from.id);
    await setMembershipStatus(from.id, ok);
    if (!ok) {
      const kb = new InlineKeyboard();
      for (const chat of missing) {
        if (chat.url) kb.url(chat.kind === 'group' ? `👥 Join ${chat.title}` : `📢 Join ${chat.title}`, chat.url).row();
      }
      kb.text('✅ I have joined', 'start:recheck');
      await ctx.reply(
        [
          '👋 <b>Welcome</b>',
          '',
          '⚠️ To use this bot you must join our channel and group first:',
          ...missing.map((c) => `• ${c.kind === 'group' ? '👥' : '📢'} <b>${escapeHtml(c.title)}</b>`),
          '',
          'Join them, then press the button below to continue.',
        ].join('\n'),
        { parse_mode: 'HTML', reply_markup: kb },
      );
      return;
    }
  }

  // 5. CAPTCHA (spec §4: "3 + 20 = ?"). A fresh registration NEVER trusts a
  //    passed flag from an older session: after admin-deletion the same
  //    Telegram account must solve the captcha again like a brand-new user.
  const captchaEnabled = await getBool('bot.captcha_enabled', true);
  const maxAttempts = await getNumber('security.max_captcha_attempts', 3);

  if (!existing) {
    ctx.session.captchaPassed = false;
    if (ctx.session.step?.type === 'captcha') ctx.session.step = undefined;
  }
  if (captchaEnabled && !ctx.session.captchaPassed) {
    if (account.captcha_attempts >= maxAttempts) {
      await ctx.reply('🚫 Too many failed verification attempts. Please try again later.');
      return;
    }
    await sendCaptcha(ctx, maxAttempts, referralCode);
    return;
  }

  // 6. Create the pending user and notify admins.
  await completeRegistration(ctx, referralCode);
}

async function sendCaptcha(ctx: BotContext, maxAttempts: number, referralCode: string | null): Promise<void> {
  const a = 2 + Math.floor(Math.random() * 8);
  const b = 5 + Math.floor(Math.random() * 15);
  // A small share of subtraction questions keeps scripted solvers on their toes.
  const useSubtraction = Math.random() < 0.3;
  const expected = useSubtraction ? a + b - a : a + b;
  const expression = useSubtraction ? `${a + b} − ${a}` : `${a} + ${b}`;

  ctx.session.step = { type: 'captcha', expected, attempts: 0, referralCode };
  ctx.session.captchaPassed = false;

  await ctx.reply(
    [
      '👋 <b>Welcome</b>',
      '',
      '⚠️ Please complete the required verification to continue.',
      '',
      '🔐 <b>CAPTCHA</b>',
      `Solve: <code>${expression} = ?</code>`,
      '',
      `Reply with the answer as a message (attempts left: ${maxAttempts}).`,
    ].join('\n'),
    { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('❌ Cancel', 'start:cancel') },
  );
}

/** Handles the plain-text answer to the CAPTCHA (registered as a text handler). */
export async function handleCaptchaAnswer(ctx: BotContext, text: string): Promise<boolean> {
  const step = ctx.session.step;
  if (!step || step.type !== 'captcha') return false;

  const from = ctx.from;
  if (!from) return true;

  const value = Number(text.trim().replace(/[^\d-]/g, ''));
  const maxAttempts = await getNumber('security.max_captcha_attempts', 3);

  if (!Number.isFinite(value) || value !== step.expected) {
    step.attempts += 1;
    await recordCaptchaAttempt(from.id, false);
    const account = await upsertTelegramAccount({
      telegramId: from.id,
      chatId: ctx.chat?.id,
      username: from.username ?? null,
    });

    if (step.attempts >= maxAttempts || account.captcha_attempts >= maxAttempts + 2) {
      ctx.session.step = undefined;
      await ctx.reply('🚫 Too many failed attempts. Please try again later or contact support.');
      await enqueueAdminNotification('ADMIN_ALERT', {
        title: 'CAPTCHA failures',
        message: `Telegram ID <code>${from.id}</code> (${from.username ?? 'no username'}) failed the captcha ${account.captcha_attempts} times.`,
      });
      return true;
    }

    await ctx.reply(`❌ Wrong answer. Attempts left: <b>${maxAttempts - step.attempts}</b>.`, { parse_mode: 'HTML' });
    return true;
  }

  // Correct.
  await recordCaptchaAttempt(from.id, true);
  ctx.session.captchaPassed = true;
  ctx.session.step = undefined;
  await sendApprovalPending(ctx, { captchaSolved: true });
  await completeRegistration(ctx, step.referralCode ?? null, { userNotified: true });
  return true;
}

/**
 * The approval-waiting screen, shown after registration and on every /start
 * while the account is PENDING. Product contract (from live feedback): a
 * pending user must NOT see the action menu - just this message and one way to
 * refresh their status.
 */
async function sendApprovalPending(ctx: BotContext, opts: { captchaSolved: boolean }): Promise<void> {
  await ctx.reply(
    [
      opts.captchaSolved ? '✅ <b>Captcha Solved!</b>' : '',
      '📋 Request sent to admin.',
      '',
      '⏳ Please wait for approval...',
      '',
      'You will be notified when approved.',
    ]
      .filter(Boolean)
      .join('\n'),
    {
      parse_mode: 'HTML',
      reply_markup: new InlineKeyboard().text('🔄 Check approval status', 'start:pending'),
    },
  );
}

/** Creates the users row (PENDING) and alerts the admins. */
async function completeRegistration(ctx: BotContext, referralCode: string | null, opts: { userNotified?: boolean } = {}): Promise<void> {
  const from = ctx.from;
  if (!from) return;

  const displayName = [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || String(from.id);
  const { user, created } = await registerUser({
    telegramId: from.id,
    username: from.username ?? null,
    displayName,
    languageCode: from.language_code ?? null,
    referralCodeFromStart: referralCode,
  });

  if (!created) {
    await sendApprovalPending(ctx, { captchaSolved: false });
    return;
  }

  await writeAudit({
    actorId: user.id,
    actorTelegramId: from.id,
    actorType: 'USER',
    action: 'USER_CAPTCHA_PASSED',
    targetType: 'user',
    targetId: user.id,
    requestId: ctx.state.requestId,
    metadata: { referral: referralCode ?? null },
  });

  const autoApprove = await getBool('bot.auto_approve', false);
  if (autoApprove) {
    const { approveUser } = await import('../../services/user.service.js');
    const { provisionSipAccount } = await import('../../services/extension.service.js');
    const adminId = env.superAdminIds[0] ?? user.id;
    await approveUser(user.id, { actorId: adminId, requestId: ctx.state.requestId }).catch((err) =>
      logger.error({ err: (err as Error).message }, 'auto-approve failed'),
    );
    try {
      const provisioned = await provisionSipAccount(user.id, { actorId: adminId, requestId: ctx.state.requestId });
      await enqueueAdminNotification(
        'ADMIN_ALERT',
        { title: 'Auto-approved user', message: `User ${displayName} was auto-approved and provisioned as extension ${provisioned.credentials.extension}.` },
        `autoapprove:${user.id}`,
      );
      await ctx.reply(
        [
          '🎉 <b>Your account is ready</b>',
          '',
          `🔑 SIP ID: <code>${provisioned.credentials.extension}</code>`,
          '',
          'Use /menu or the button below to view your SIP information.',
        ].join('\n'),
        { parse_mode: 'HTML', reply_markup: backToMenuKeyboard(false) },
      );
    } catch (err) {
      await ctx.reply('⚠️ Your account was approved but the SIP account could not be created yet. An administrator has been notified.');
      await enqueueAdminNotification(
        'ADMIN_ALERT',
        { title: 'Auto-approve provisioning failed', message: `User ${displayName} (${user.id}): ${(err as Error).message}` },
        `autoapprove-fail:${user.id}`,
      );
    }
    return;
  }

  // Operators skip the queue entirely (see src/bot/handlers/staff.ts). Ordinary
  // applicants stay PENDING and are announced to the admins below.
  const activation = await activateStaffAccount(ctx);
  if (activation.activated) {
    await ctx.reply(
      [
        '✅ <b>Operator account activated</b>',
        '',
        activation.extension ? `🔑 SIP ID: <code>${activation.extension}</code>` : '',
        activation.provisioningError
          ? '⚠️ SIP account could not be created yet; retry from 🛠 Admin Panel → 👥 Users.'
          : 'Use ☎️ Get Number to request your first DID.',
      ]
        .filter(Boolean)
        .join('\n'),
      { parse_mode: 'HTML', reply_markup: mainMenuKeyboard(true) },
    );
    await renderMainMenu(ctx);
    return;
  }

  // Notify every admin with the approval request (spec §4).
  const registered = new Date().toISOString().slice(0, 16).replace('T', ' ');
  await enqueueAdminNotification(
    'ADMIN_NEW_USER',
    {
      telegramId: from.id,
      username: from.username ? `@${from.username}` : '—',
      displayName,
      registeredAt: registered,
      userId: user.id,
    },
    `newuser:${user.id}`,
  );

  // Captcha off → this is the first thing the applicant hears after /start;
  // captcha on → the waiting screen was already shown before registration.
  if (!opts.userNotified) await sendApprovalPending(ctx, { captchaSolved: false });
}

export function extractStartPayload(ctx: BotContext): string | null {
  const text = ctx.message?.text ?? '';
  const match = text.match(/^\/start(?:@\w+)?\s+(.+)$/);
  if (!match) return null;
  const raw = (match[1] ?? '').trim();
  if (!raw) return null;
  // Telegram sometimes sends the payload base64/'start=' style; keep it simple
  // and only accept plain referral codes.
  return raw.replace(/^ref_?/i, '');
}

export async function isChannelMember(ctx: BotContext, channel: string): Promise<boolean> {
  try {
    const member = await ctx.api.getChatMember(channel, ctx.from!.id);
    return ['creator', 'administrator', 'member', 'restricted'].includes(member.status);
  } catch (err) {
    logger.warn({ err: (err as Error).message, channel }, 'channel membership check failed; allowing the user through');
    // Fail-open on API errors: a broken membership check must not lock every
    // user out of the bot. The admin sees the warning in the log.
    return true;
  }
}

export async function handlePendingCheck(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  await handleStart(ctx);
}

export async function handleStartRecheck(ctx: BotContext): Promise<void> {
  if (!ctx.from) return;
  const { ok, missing } = await checkRequiredMembership(ctx.api, ctx.from.id);
  await setMembershipStatus(ctx.from.id, ok);
  await ctx
    .answerCallbackQuery(ok ? '✅ Membership confirmed' : `❌ Still missing: ${missing.map((c) => c.title).join(', ')}`)
    .catch(() => undefined);
  if (ok) {
    // Wipe any stale verification state so the captcha always re-runs for a
    // registration that had to re-verify membership.
    ctx.session.captchaPassed = false;
    if (ctx.session.step?.type === 'captcha') ctx.session.step = undefined;
    await ctx.deleteMessage().catch(() => undefined);
    await handleStart(ctx);
  }
}

export async function handleStartCancel(ctx: BotContext): Promise<void> {
  ctx.session.step = undefined;
  await ctx.answerCallbackQuery('Cancelled');
  await ctx.editMessageText('❌ Registration cancelled. Send /start to begin again.').catch(() => undefined);
}

/** /help — deliberately short; the UI is button-driven. */
export async function handleHelp(ctx: BotContext): Promise<void> {
  await ctx.reply(
    [
      'ℹ️ <b>Help</b>',
      '',
      'All actions are available from the menu buttons.',
      '',
      '<b>Commands</b>',
      '/start — register or open the menu',
      '/menu — main menu',
      '/help — this message',
      '/cancel — abort the current step',
      '',
      `🆘 Support: ${env.SUPPORT_USERNAME ? `@${env.SUPPORT_USERNAME}` : 'use the Support button'}`,
    ].join('\n'),
    { parse_mode: 'HTML', reply_markup: mainMenuKeyboard(ctx.state.isAdmin) },
  );
}

export async function refreshRole(ctx: BotContext): Promise<void> {
  if (!ctx.from) return;
  const user = await findUserForTelegram(ctx.from.id);
  ctx.state.user = user ?? undefined;
  ctx.state.role = await resolveRole(ctx.from.id, user?.id ?? null);
  ctx.state.isAdmin = ['super_admin', 'admin', 'support'].includes(ctx.state.role);
  ctx.state.isSuperAdmin = ctx.state.role === 'super_admin';
  void getString('bot.name', 'SIP Service').catch(() => undefined);
}
