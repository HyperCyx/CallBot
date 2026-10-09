import { InlineKeyboard } from 'grammy';
import { adminFundWallet, approveDepositRequest, listPendingDeposits, rejectDepositRequest } from '../../services/deposit.service.js';
import { createPaymentMethod, deletePaymentMethod, getPaymentMethod, listAllPaymentMethods, setPaymentMethodStatus, updatePaymentMethodAddress } from '../../services/payment-method.service.js';
import { formatUsd, getWallet } from '../../services/wallet.service.js';
import { toAppError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { formatDate, formatDateTime, formatDuration } from '../../lib/time.js';
import type { BotContext } from '../context.js';
import { dropNavMatching } from '../nav.js';
import {
  CB,
  adminMenuKeyboard,
  auditKeyboard,
  backToMenuKeyboard,
  commissionKeyboard,
  confirmKeyboard,
  countriesKeyboard,
  countryDetailKeyboard,
  findingsKeyboard,
  healthKeyboard,
  numberRowKeyboard,
  numbersMenuKeyboard,
  planDetailKeyboard,
  planPickerKeyboard,
  plansKeyboard,
  referralsAdminKeyboard,
  referrerListKeyboard,
  serviceDetailKeyboard,
  servicesKeyboard,
  settingsKeyboard,
  depositsQueueKeyboard,
  paymentMethodDetailKeyboard,
  paymentMethodsKeyboard,
  userDetailKeyboard,
  userListKeyboard,
  withBack,
  numberLine,
} from '../keyboards.js';
import { getDashboard, getInventoryBreakdown, formatMoney } from '../../services/stats.service.js';
import {
  approveUser,
  blockUser,
  changeUserPlan,
  findUserForTelegram,
  getUserById,
  getUserRoles,
  grantRole,
  listUsers,
  rejectUser,
  revokeRole,
  softDeleteUser,
  unblockUser,
} from '../../services/user.service.js';
import { provisionSipAccount, deleteSipAccount, getSipAccountByUser, revealCredentials, rotateSipPassword, listSipAccountsWithUser } from '../../services/extension.service.js';
import { deliverApprovalCredentials } from '../../services/approvalDelivery.service.js';
import {
  countryRemovalImpact,
  deleteCountry,
  createCountry,
  createService,
  deleteService,
  getCountry,
  getService,
  listCountries,
  listPlans,
  listServices,
  serviceRemovalImpact,
  updateCountry,
  updateService,
  updatePlan,
} from '../../services/catalog.service.js';
import {
  countNumbersByStatus,
  deleteNumber,
  getNumberById,
  importNumbers,
  inventoryRemovalPreview,
  listImportBatches,
  listNumbers,
  removeAllAvailableNumbers,
  updateNumber,
} from '../../services/inventory.service.js';
import { reassignNumber, releaseNumber, suspendNumber, unsuspendNumber } from '../../services/assignment.service.js';
import { deleteUserAccount } from '../../services/userDeletion.service.js';
import { getLiveCalls, getSystemCallHistory, liveCallSourceStatus } from '../../services/call.service.js';
import { getReferralProgramSummary, listPendingCommissions, markCommissionPaid, rejectReferral } from '../../services/referral.service.js';
import { getOpenFindings, resolveFinding, runReconciliation } from '../../workers/reconcile.worker.js';
import { getAllSettings, setSetting } from '../../services/settings.service.js';
import { listAuditLogs, countAuditLogs } from '../../services/audit.service.js';
import { getStoredCompatibilityReport, runCompatibilityProbe } from '../../freepbx/compat.js';
import { FreePBXGraphQLClient } from '../../freepbx/client.js';
import { env } from '../../config/env.js';
import { many } from '../../db/pool.js';
import { enqueueAdminNotification, enqueueNotification } from '../../services/notification.service.js';
import { maskNumber } from '../../lib/logger.js';

/**
 * Admin panel (spec §19, §20, §21, §24, §25, §26, §28, §31, §33).
 *
 * Access control is enforced by middleware before any handler here runs
 * (`requireAdmin`), and every mutating action writes an audit row through the
 * service layer. Destructive actions are always behind a confirmation step.
 */

// -----------------------------------------------------------------------------
// Dashboard / home
// -----------------------------------------------------------------------------

export async function renderAdminHome(ctx: BotContext, opts: { edit?: boolean } = {}): Promise<void> {
  const [dashboard, pending] = await Promise.all([getDashboard(), listUsers({ status: 'PENDING', limit: 1 })]);

  const text = [
    '🛠 <b>Admin Panel</b>',
    '',
    '📊 <b>Users</b>',
    `Total: ${dashboard.users.total} · Active: ${dashboard.users.active} · Pending: ${dashboard.users.pending}`,
    `Blocked: ${dashboard.users.blocked} · Premium: ${dashboard.users.premium}`,
    '',
    '☎️ <b>Numbers</b>',
    `Total: ${dashboard.numbers['TOTAL'] ?? 0} · Available: ${dashboard.numbers['AVAILABLE'] ?? 0}`,
    `Assigned: ${dashboard.numbers['ASSIGNED'] ?? 0} · Suspended: ${dashboard.numbers['SUSPENDED'] ?? 0}`,
    '',
    '📞 <b>Calls</b>',
    `Live: ${dashboard.liveCalls} · Today: ${dashboard.callsToday}`,
    '',
    '💰 <b>Referrals</b>',
    `Pending: ${formatMoney(dashboard.referral.pendingCents)} · Paid: ${formatMoney(dashboard.referral.paidCents)}`,
    '',
    '🩺 <b>Health</b>',
    `PBX jobs pending: ${dashboard.health.pendingPbxJobs}${dashboard.health.deadPbxJobs > 0 ? ` (⚠️ ${dashboard.health.deadPbxJobs} dead)` : ''}`,
    `Critical findings: ${dashboard.health.criticalFindings}`,
    `Live monitoring: ${dashboard.health.amiConnected ? '🟢 connected' : '⚪️ unavailable'}`,
    `DB latency: ${dashboard.health.dbLatencyMs}ms`,
  ].join('\n');

  const keyboard = adminMenuKeyboard(pending.total, dashboard.health.criticalFindings);

  if (opts.edit) {
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard }).catch(async () => {
      await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
    });
    return;
  }
  await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
}

export async function handleAdminHome(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  await renderAdminHome(ctx, { edit: true });
}

export async function handleDashboard(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const [dashboard, breakdown] = await Promise.all([getDashboard(), getInventoryBreakdown(6)]);

  const lines = [
    '📊 <b>Dashboard</b>',
    '',
    `👥 Users: ${dashboard.users.total}`,
    `✅ Active: ${dashboard.users.active}`,
    `⏳ Pending: ${dashboard.users.pending}`,
    `⛔️ Blocked: ${dashboard.users.blocked}`,
    `⌛️ Expired: ${dashboard.users.expired}`,
    `💎 Premium: ${dashboard.users.premium}`,
    '',
    `☎️ Numbers: ${dashboard.numbers['TOTAL'] ?? 0}`,
    `🟢 Available: ${dashboard.numbers['AVAILABLE'] ?? 0}`,
    `📞 Assigned: ${dashboard.numbers['ASSIGNED'] ?? 0}`,
    `⚠️ Suspended: ${dashboard.numbers['SUSPENDED'] ?? 0}`,
    `⏳ Reserved: ${dashboard.numbers['RESERVED'] ?? 0}`,
    '',
    `📞 Live calls: ${dashboard.liveCalls}`,
    `🗂 Calls today: ${dashboard.callsToday}`,
    '',
    `💰 Referral balance: ${formatMoney(dashboard.referral.pendingCents + dashboard.referral.paidCents)}`,
    '',
    '📦 <b>Inventory by offer</b>',
    ...breakdown.map((b) => `${b.flag ?? '🌍'} ${b.country} · ${b.service} ${b.plan_type === 'PREMIUM' ? '💎' : ''} — 🟢${b.available} 📞${b.assigned} ⚠️${b.suspended}`),
  ];

  await ctx.editMessageText(lines.join('\n'), {
    parse_mode: 'HTML',
    reply_markup: withBack(new InlineKeyboard().text('🔄 Refresh', 'a:dash').row().text('🛠 Admin Panel', 'a:home')),
  });
}

// -----------------------------------------------------------------------------
// Users (spec §19)
// -----------------------------------------------------------------------------

export async function handleUserList(ctx: BotContext, filter: string, page: number): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const pageSize = 5;
  const { rows, total } = await listUsers({
    status: (filter === 'ALL' ? 'ALL' : (filter as never)) as never,
    limit: pageSize,
    offset: page * pageSize,
  });

  const lines = [`👥 <b>Users</b> — ${filter} (${total})`, ''];
  if (rows.length === 0) lines.push('No users in this filter.');

  for (const user of rows) {
    const icon = user.status === 'PENDING' ? '⏳' : user.status === 'ACTIVE' ? '✅' : user.status === 'BLOCKED' ? '⛔️' : '⌛️';
    lines.push(`${icon} ${user.username ? `@${user.username}` : user.display_name ?? 'user'} · <code>${user.telegram_id ?? '—'}</code> · ${user.plan_code ?? '—'}`);
  }

  await ctx.editMessageText(lines.join('\n'), {
    parse_mode: 'HTML',
    reply_markup: userListKeyboard(rows.map((u) => ({ id: u.id, username: u.username, telegram_id: u.telegram_id, status: u.status })), page, total, pageSize, filter),
  });
}

export async function handleUserDetail(ctx: BotContext, userId: string): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const user = await getUserById(userId);
  if (!user) {
    await ctx.editMessageText('❌ User not found.', { reply_markup: backToMenuKeyboard(true) });
    return;
  }

  const [roles, sip, numbers, wallet] = await Promise.all([
    getUserRoles(user.id),
    getSipAccountByUser(user.id),
    listNumbers({ assignedUserId: user.id, limit: 10 }),
    getWallet(user.id),
  ]);

  const lines = [
    '👤 <b>User details</b>',
    '',
    `ID: <code>${user.id}</code>`,
    `Telegram: <code>${user.telegram_id ?? '—'}</code>`,
    `Username: ${user.username ? `@${user.username}` : '—'}`,
    `Name: ${user.display_name ?? '—'}`,
    `Status: ${user.status}`,
    `Plan: ${user.plan_name ?? '—'}`,
    `Expires: ${formatDate(user.expires_at)}`,
    `Registered: ${formatDateTime(user.created_at)}`,
    `Roles: ${roles.join(', ') || 'user'}`,
    '',
    `🔑 SIP: <code>${sip?.extension ?? '—'}</code> (${sip?.status ?? 'none'})`,
    `☎️ Numbers: ${numbers.total}`,
    ...numbers.rows.slice(0, 5).map((n) => `   ${numberLine(n)}`),
    '',
    `🔗 Referral code: <code>${user.referral_code ?? '—'}</code>`,
    `💰 Wallet balance: <b>${formatUsd(wallet.balance_cents)}</b>`,
  ];

  if (user.blocked_reason) lines.push('', `⛔️ Reason: ${user.blocked_reason}`);

  await ctx.editMessageText(lines.join('\n'), {
    parse_mode: 'HTML',
    reply_markup: userDetailKeyboard(user.id, user.status, roles.includes('admin') || roles.includes('super_admin') || roles.includes('support')),
  });
}

export async function handleUserApprove(ctx: BotContext, userId: string): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const user = await getUserById(userId);
  if (!user) return;

  await ctx.editMessageText('⏳ Approving and provisioning the SIP account…', { parse_mode: 'HTML' });

  try {
    const approved = await approveUser(userId, { actorId: ctx.state.user?.id ?? userId, actorTelegramId: ctx.from?.id ?? null, requestId: ctx.state.requestId });
    const provisioned = await provisionSipAccount(userId, {
      actorId: ctx.state.user?.id ?? userId,
      requestId: ctx.state.requestId,
    });

    await ctx.editMessageText(
      [
        '✅ <b>User approved</b>',
        '',
        `👤 ${user.username ? `@${user.username}` : user.display_name ?? user.telegram_id}`,
        `🔑 SIP extension: <code>${provisioned.credentials.extension}</code>`,
        provisioned.pbxWarning ? `\nℹ️ ${provisioned.pbxWarning}` : '',
        '',
        'The user has received their SIP credentials and can now request numbers.',
      ]
        .filter(Boolean)
        .join('\n'),
      { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('👤 User', `a:u:${userId}`).row().text('🛠 Admin', 'a:home') },
    );

    // The user gets their SIP ID/password/host in a one-shot DM (never
    // persisted: the password lives only encrypted in sip_accounts). When the
    // chat is unreachable, fall back to the password-free notification.
    const delivered = await deliverApprovalCredentials({
      telegramId: Number(approved.telegram_id),
      extension: provisioned.credentials.extension,
      password: provisioned.credentials.password,
      expiresAt: approved.expires_at,
    });
    if (!delivered) {
      await enqueueNotification({
        userId,
        kind: 'USER_APPROVED',
        payload: { extension: provisioned.credentials.extension },
        dedupeKey: `approved:${userId}`,
      });
    }

    // Heads-up to ALL admins (including the actor): registration was approved.
    // Per-decision dedupe so a crash/restart can never re-page the room.
    await enqueueAdminNotification('ADMIN_ALERT', {
      text: [
        '✅ <b>Registration approved</b>',
        `👤 ${user.username ? `@${user.username}` : user.display_name ?? user.telegram_id} (tg ${user.telegram_id})`,
        `🔑 SIP extension: <code>${provisioned.credentials.extension}</code>`,
        `by ${ctx.from?.username ? `@${ctx.from.username}` : ctx.from?.id ?? 'admin'}`,
      ].join('\n'),
    }, `uact:approve:${userId}`).catch(() => undefined);
  } catch (err) {
    const appError = toAppError(err);
    await ctx.editMessageText(
      [
        '⚠️ <b>Approved, but provisioning failed</b>',
        '',
        appError.userMessage,
        '',
        'The user is active; retry provisioning from the user screen once the PBX is reachable.',
      ].join('\n'),
      { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('👤 User', `a:u:${userId}`).row().text('🛠 Admin', 'a:home') },
    );
    await enqueueAdminNotification('ADMIN_ALERT', {
      text: [
        '⚠️ <b>Registration approved, provisioning FAILED</b>',
        `👤 ${user.username ? `@${user.username}` : user.display_name ?? user.telegram_id} (tg ${user.telegram_id})`,
        toAppError(err).userMessage,
        'Retry provisioning from the user screen.',
      ].join('\n'),
    }, `uact:approve:${userId}`).catch(() => undefined);
  }
}

export async function handleUserReject(ctx: BotContext, userId: string): Promise<void> {
  const user = await getUserById(userId);
  if (!user) return;
  await ctx.answerCallbackQuery().catch(() => undefined);
  await ctx.editMessageText(
    ['❌ <b>Reject this registration?</b>', '', `User: ${user.username ? `@${user.username}` : user.display_name ?? user.telegram_id}`].join('\n'),
    { parse_mode: 'HTML', reply_markup: confirmKeyboard(`a:urejok:${userId}`, `a:u:${userId}`, '❌ Reject', '⬅️ Back') },
  );
}

export async function handleUserRejectConfirm(ctx: BotContext, userId: string): Promise<void> {
  const user = await getUserById(userId);
  if (!user) return;
  await ctx.answerCallbackQuery().catch(() => undefined);

  await rejectUser(userId, { actorId: ctx.state.user?.id ?? userId, reason: 'rejected by admin', requestId: ctx.state.requestId });
  await enqueueNotification({ userId, kind: 'USER_REJECTED', payload: {}, dedupeKey: `rejected:${userId}` });

  // Heads-up to ALL admins: registration was rejected (and by whom).
  await enqueueAdminNotification('ADMIN_ALERT', {
    text: [
      '❌ <b>Registration rejected</b>',
      `👤 ${user.username ? `@${user.username}` : user.display_name ?? user.telegram_id} (tg ${user.telegram_id})`,
      `by ${ctx.from?.username ? `@${ctx.from.username}` : ctx.from?.id ?? 'admin'}`,
    ].join('\n'),
  }, `uact:reject:${userId}`).catch(() => undefined);

  await ctx.editMessageText('🚫 Registration rejected. The user has been notified.', {
    reply_markup: new InlineKeyboard().text('👥 Users', 'a:users').row().text('🛠 Admin', 'a:home'),
  });
}

export async function handleUserBlock(ctx: BotContext, userId: string): Promise<void> {
  const user = await getUserById(userId);
  if (!user) return;
  await ctx.answerCallbackQuery().catch(() => undefined);
  await ctx.editMessageText(
    ['⛔️ <b>Block this user?</b>', '', 'Their numbers stay assigned but they cannot use the bot or request more numbers.'].join('\n'),
    { parse_mode: 'HTML', reply_markup: confirmKeyboard(`a:ublkok:${userId}`, `a:u:${userId}`, '⛔️ Block', '❌ Cancel') },
  );
}

export async function handleUserBlockConfirm(ctx: BotContext, userId: string): Promise<void> {
  const user = await getUserById(userId);
  if (!user) return;
  await ctx.answerCallbackQuery().catch(() => undefined);

  await blockUser(userId, { actorId: ctx.state.user?.id ?? userId, reason: 'blocked by admin', requestId: ctx.state.requestId });
  await enqueueNotification({ userId, kind: 'USER_BLOCKED', payload: { reason: 'blocked by an administrator' }, dedupeKey: `blocked:${userId}:${Date.now()}` });

  await ctx.editMessageText('⛔️ User blocked.', { reply_markup: new InlineKeyboard().text('👤 User', `a:u:${userId}`).row().text('🛠 Admin', 'a:home') });
}

export async function handleUserUnblock(ctx: BotContext, userId: string): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  await unblockUser(userId, { actorId: ctx.state.user?.id ?? userId, requestId: ctx.state.requestId });
  await enqueueNotification({ userId, kind: 'USER_UNBLOCKED', payload: {}, dedupeKey: `unblocked:${userId}:${Date.now()}` });
  await handleUserDetail(ctx, userId);
}

export async function handleUserDelete(ctx: BotContext, userId: string): Promise<void> {
  const user = await getUserById(userId);
  if (!user) return;
  const numbers = await listNumbers({ assignedUserId: userId, limit: 20 });
  await ctx.answerCallbackQuery().catch(() => undefined);

  await ctx.editMessageText(
    [
      '🗑 <b>Delete this user?</b>',
      '',
      `👤 ${user.username ? `@${user.username}` : user.display_name ?? user.telegram_id}`,
      numbers.total > 0
        ? `☎️ ${numbers.total} number(s) assigned — they are released back to inventory and their inbound routes removed.`
        : '☎️ No numbers assigned.',
      '📞 The SIP account and its PBX extension are deleted.',
      '',
      'The account is soft-deleted: audit history and call records are preserved.',
    ].join('\n'),
    { parse_mode: 'HTML', reply_markup: confirmKeyboard(`a:udelok:${userId}`, `a:u:${userId}`, '🗑 Delete', '❌ Cancel') },
  );
}

export async function handleUserDeleteConfirm(ctx: BotContext, userId: string): Promise<void> {
  const user = await getUserById(userId);
  if (!user) return;
  await ctx.answerCallbackQuery().catch(() => undefined);

  try {
    // Releases every number the account still holds, removes their inbound
    // routes, deletes the SIP account and its PBX extension, then deletes the
    // account - one service so the panel and the API cannot drift apart.
    const result = await deleteUserAccount(userId, {
      actorId: ctx.state.user?.id ?? userId,
      actorTelegramId: ctx.from?.id ?? null,
      requestId: ctx.state.requestId,
    });
    dropNavMatching(ctx, (data) => data.includes(userId));

    await ctx.editMessageText(
      [
        '🗑 <b>User deleted.</b>',
        '',
        result.releasedNumbers > 0
          ? `☎️ ${result.releasedNumbers} number(s) returned to inventory, routes removed.`
          : '☎️ No numbers were assigned.',
        result.sipAccountDeleted ? '📞 SIP account and PBX extension deleted.' : '📞 No SIP account to delete.',
      ].join('\n'),
      { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('👥 Users', 'a:users').row().text('🛠 Admin', 'a:home') },
    );
  } catch (err) {
    await ctx.editMessageText(['❌ <b>Deletion failed</b>', '', toAppError(err).userMessage].join('\n'), {
      parse_mode: 'HTML',
      reply_markup: new InlineKeyboard().text('👤 User', `a:u:${userId}`).row().text('🛠 Admin', 'a:home'),
    });
  }
}

export async function handleUserPlanPicker(ctx: BotContext, userId: string): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const plans = await listPlans({ activeOnly: true });
  await ctx.editMessageText('💎 <b>Choose the new plan</b>', { parse_mode: 'HTML', reply_markup: planPickerKeyboard(plans, `a:uplanok:${userId}`) });
}

export async function handleUserPlanSet(ctx: BotContext, userId: string, planId: string): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  await changeUserPlan(userId, planId, { actorId: ctx.state.user?.id ?? userId, requestId: ctx.state.requestId });
  await handleUserDetail(ctx, userId);
}

export async function handleUserRoles(ctx: BotContext, userId: string): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  if (!ctx.state.isSuperAdmin) {
    await ctx.answerCallbackQuery('Only a super admin can manage roles.').catch(() => undefined);
    return;
  }
  const roles = await getUserRoles(userId);
  const kb = new InlineKeyboard();
  for (const code of ['admin', 'support', 'user']) {
    const has = roles.includes(code);
    kb.text(`${has ? '✅' : '⬜️'} ${code}`, `a:urolet:${userId}:${code}`).row();
  }
  kb.text('⬅️ User', `a:u:${userId}`);

  await ctx.editMessageText(['🔐 <b>Roles</b>', '', 'Tap to grant or revoke. Super admin is controlled by the environment allowlist and cannot be changed here.'].join('\n'), {
    parse_mode: 'HTML',
    reply_markup: kb,
  });
}

export async function handleUserRoleToggle(ctx: BotContext, userId: string, role: string): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  if (!ctx.state.isSuperAdmin) return;
  const actorId = ctx.state.user?.id;
  if (!actorId) return;

  const roles = await getUserRoles(userId);
  if (roles.includes(role)) await revokeRole(userId, role, actorId);
  else await grantRole(userId, role, actorId);
  await handleUserRoles(ctx, userId);
}

export async function handleUserSearch(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  ctx.session.step = { type: 'admin_search_user' };
  await ctx.editMessageText(
    ['🔍 <b>Search user</b>', '', 'Send a username, Telegram ID, display name or referral code.', '', 'Type /cancel to stop.'].join('\n'),
    { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('❌ Cancel', 'a:users') },
  );
}

export async function handleUserSearchQuery(ctx: BotContext, query: string): Promise<void> {
  ctx.session.step = undefined;
  const { rows, total } = await listUsers({ search: query.replace('@', ''), limit: 10 });

  const lines = [`🔍 <b>Results for</b> <code>${query}</code> — ${total} found`, ''];
  if (rows.length === 0) lines.push('Nothing found.');
  for (const user of rows) {
    lines.push(`${user.status === 'ACTIVE' ? '✅' : user.status === 'PENDING' ? '⏳' : '⛔️'} ${user.username ? `@${user.username}` : user.display_name ?? 'user'} · <code>${user.telegram_id ?? '—'}</code>`);
  }

  const kb = new InlineKeyboard();
  for (const user of rows) kb.text(`👤 ${user.username ?? user.telegram_id ?? 'user'}`, `a:u:${user.id}`).row();
  kb.text('⬅️ Users', 'a:users');

  await ctx.reply(lines.join('\n'), { parse_mode: 'HTML', reply_markup: kb });
}

export async function handleUserSipCredentials(ctx: BotContext, userId: string): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const account = await getSipAccountByUser(userId);
  if (!account) {
    await ctx.answerCallbackQuery('No SIP account for this user.').catch(() => undefined);
    return;
  }
  // Admin credential access is audited as SIP_PASSWORD_VIEWED.
  const credentials = await revealCredentials(account.id, {
    actorId: ctx.state.user?.id ?? null,
    reason: 'admin viewed credentials from the Telegram panel',
  });

  await ctx.reply(
    [
      '🔑 <b>SIP credentials</b>',
      '',
      `👤 User: <code>${userId}</code>`,
      `🔑 SIP ID: <code>${credentials.extension}</code>`,
      `🔒 Password: <code>${credentials.password}</code>`,
      `🌐 Server: <code>${credentials.server}</code>:${credentials.port} (${credentials.transport})`,
      '',
      '⚠️ This view was written to the audit log.',
    ].join('\n'),
    { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('⬅️ User', `a:u:${userId}`).row().text('🛠 Admin', 'a:home') },
  );
}

export async function handleUserNumbers(ctx: BotContext, userId: string): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const { rows } = await listNumbers({ assignedUserId: userId, limit: 20 });
  const lines = ['📞 <b>User numbers</b>', ''];
  if (rows.length === 0) lines.push('None.');
  for (const n of rows) lines.push(numberLine(n));

  const kb = new InlineKeyboard();
  for (const n of rows.slice(0, 8)) kb.text(`📞 ${n.phone_number}`, `a:n:${n.id}`).row();
  kb.text('⬅️ User', `a:u:${userId}`);

  await ctx.editMessageText(lines.join('\n'), { parse_mode: 'HTML', reply_markup: kb });
}

export async function handleUserCalls(ctx: BotContext, userId: string): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const user = await getUserById(userId);
  const { rows, total } = await getSystemCallHistory({ limit: 10 });
  const mine = rows.filter((r) => r.username === user?.username);

  const lines = [`🗂 <b>Recent calls</b> for ${user?.username ?? userId} — ${mine.length} of ${total} loaded`, ''];
  if (mine.length === 0) lines.push('No calls found for this user in the latest batch.');
  for (const call of mine) {
    lines.push(`• <code>${maskNumber(call.src ?? '')}</code> → <code>${maskNumber(call.dst ?? '')}</code> · ${formatDateTime(call.calldate)} · ${formatDuration(call.billsec)} · ${call.disposition ?? '—'}`);
  }

  await ctx.editMessageText(lines.join('\n'), { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('⬅️ User', `a:u:${userId}`) });
}

export async function handleUserReferral(ctx: BotContext, userId: string): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const rows = await many<{ code: string | null; referred: string; qualified: string; earned: string }>(
    `SELECT u.referral_code AS code,
            (SELECT count(*)::text FROM referrals r WHERE r.referrer_user_id = u.id) AS referred,
            (SELECT count(*)::text FROM referrals r WHERE r.referrer_user_id = u.id AND r.status IN ('QUALIFIED','PAID')) AS qualified,
            (SELECT COALESCE(sum(c.amount_cents),0)::text FROM referral_commissions c WHERE c.referrer_user_id = u.id AND c.status <> 'REVERSED') AS earned
       FROM users u WHERE u.id = $1`,
    [userId],
  );
  const row = rows[0];

  await ctx.editMessageText(
    [
      '💰 <b>Referral details</b>',
      '',
      `Code: <code>${row?.code ?? '—'}</code>`,
      `Invited: ${row?.referred ?? 0}`,
      `Qualified: ${row?.qualified ?? 0}`,
      `Earned: ${formatMoney(Number(row?.earned ?? 0))}`,
    ].join('\n'),
    { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('⬅️ User', `a:u:${userId}`) },
  );
}

// -----------------------------------------------------------------------------
// Numbers (spec §10 - §17, §25)
// -----------------------------------------------------------------------------

export async function handleNumbersMenu(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const counts = await countNumbersByStatus();
  await ctx.editMessageText(
    [
      '☎️ <b>Number inventory</b>',
      '',
      `Total: ${counts.TOTAL ?? 0}`,
      `🟢 Available: ${counts.AVAILABLE ?? 0}`,
      `📞 Assigned: ${counts.ASSIGNED ?? 0}`,
      `⚠️ Suspended: ${counts.SUSPENDED ?? 0}`,
      `⏳ Reserved: ${counts.RESERVED ?? 0}`,
      `⌛️ Expired: ${counts.EXPIRED ?? 0}`,
    ].join('\n'),
    { parse_mode: 'HTML', reply_markup: numbersMenuKeyboard() },
  );
}

export async function handleNumberList(ctx: BotContext, status: string, page: number): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const pageSize = 8;
  const { rows, total } = await listNumbers({
    status: status as never,
    limit: pageSize,
    offset: page * pageSize,
  });

  const lines = [`☎️ <b>Inventory</b> — ${status} (${total})`, ''];
  if (rows.length === 0) lines.push('Nothing here.');

  const kb = new InlineKeyboard();
  for (const n of rows) {
    lines.push(numberLine(n));
    kb.text(`${n.phone_number}`, `a:n:${n.id}`).row();
  }

  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages > 1) {
    if (page > 0) kb.text('⬅️', `a:nlist:${status}:${page - 1}`);
    kb.text(`${page + 1}/${pages}`, 'noop');
    if (page < pages - 1) kb.text('➡️', `a:nlist:${status}:${page + 1}`);
    kb.row();
  }
  kb.text('☎️ Numbers', 'a:numbers').row();
  await ctx.editMessageText(lines.join('\n'), { parse_mode: 'HTML', reply_markup: withBack(kb) });
}

export async function handleNumberDetail(ctx: BotContext, numberId: string): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const number = await getNumberById(numberId);
  if (!number) {
    await ctx.editMessageText('❌ Number not found.', {
      reply_markup: withBack(new InlineKeyboard().text('☎️ Inventory', 'a:nlist:AVAILABLE:0')),
    });
    return;
  }

  const owner = number.assigned_user_id ? await getUserById(number.assigned_user_id) : null;
  const route = await many<{ freepbx_route_id: string | null; did_match_pattern: string; destination_connection?: string; status: string; last_error: string | null }>(
    `SELECT freepbx_route_id, did_match_pattern, status, last_error FROM inbound_route_mappings
      WHERE number_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1`,
    [numberId],
  );

  const lines = [
    '📞 <b>Number details</b>',
    '',
    `DID: <code>${number.phone_number}</code>`,
    `Match pattern: <code>${number.did_match_pattern ?? '—'}</code>`,
    `Status: ${number.status}`,
    `Country: ${number.country_flag ?? ''} ${number.country_name}`,
    `Service: ${number.service_icon ?? ''} ${number.service_name}`,
    `Type: ${number.plan_type}`,
    `Provider: ${number.provider ?? '—'}`,
    `Expires: ${formatDate(number.expiration_date)}`,
    '',
    owner ? `👤 Owner: ${owner.username ? `@${owner.username}` : owner.display_name} (<code>${owner.id}</code>)` : '👤 Owner: —',
    `🔑 Extension: <code>${number.sip_extension ?? '—'}</code>`,
    '',
    route[0]
      ? `🔗 Route: <code>${route[0].freepbx_route_id ?? 'not applied'}</code> (${route[0].status})${route[0].last_error ? `\n⚠️ ${route[0].last_error}` : ''}`
      : '🔗 Route: none',
  ];

  await ctx.editMessageText(lines.join('\n'), { parse_mode: 'HTML', reply_markup: numberRowKeyboard(numberId, number.status) });
}

export async function handleNumberSuspend(ctx: BotContext, numberId: string): Promise<void> {
  const number = await getNumberById(numberId);
  if (!number) return;
  await ctx.answerCallbackQuery().catch(() => undefined);
  await ctx.editMessageText(
    [
      '⚠️ <b>Suspend this number?</b>',
      '',
      `DID: <code>${number.phone_number}</code>`,
      '',
      'The inbound route will be removed so calls stop reaching the user. The number stays in inventory and still belongs to them.',
    ].join('\n'),
    { parse_mode: 'HTML', reply_markup: confirmKeyboard(`a:nsuspok:${numberId}`, `a:n:${numberId}`, '⚠️ Suspend', '❌ Cancel') },
  );
}

export async function handleNumberSuspendConfirm(ctx: BotContext, numberId: string): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const number = await getNumberById(numberId);
  if (!number) return;

  try {
    await suspendNumber(numberId, {
      actorId: ctx.state.user?.id ?? 'admin',
      reason: 'suspended by admin',
      requestId: ctx.state.requestId,
    });
    if (number.assigned_user_id) {
      await enqueueNotification({
        userId: number.assigned_user_id,
        kind: 'NUMBER_SUSPENDED',
        payload: { phoneNumber: number.phone_number },
        dedupeKey: `suspended:${numberId}:${Date.now()}`,
      });
    }
    await ctx.editMessageText('⚠️ Number suspended and its route removed.', {
      reply_markup: new InlineKeyboard().text('📞 Number', `a:n:${numberId}`).row().text('🛠 Admin', 'a:home'),
    });
  } catch (err) {
    await ctx.editMessageText(['❌ ' + toAppError(err).userMessage].join('\n'), { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('⬅️ Back', `a:n:${numberId}`) });
  }
}

export async function handleNumberUnsuspend(ctx: BotContext, numberId: string): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const number = await getNumberById(numberId);
  if (!number) return;

  try {
    await unsuspendNumber(numberId, { actorId: ctx.state.user?.id ?? 'admin', requestId: ctx.state.requestId });
    if (number.assigned_user_id) {
      await enqueueNotification({
        userId: number.assigned_user_id,
        kind: 'NUMBER_UNSUSPENDED',
        payload: { phoneNumber: number.phone_number },
        dedupeKey: `unsuspended:${numberId}:${Date.now()}`,
      });
    }
    await handleNumberDetail(ctx, numberId);
  } catch (err) {
    await ctx.editMessageText(['❌ ' + toAppError(err).userMessage].join('\n'), { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('⬅️ Back', `a:n:${numberId}`) });
  }
}

export async function handleNumberRelease(ctx: BotContext, numberId: string): Promise<void> {
  const number = await getNumberById(numberId);
  if (!number) return;
  await ctx.answerCallbackQuery().catch(() => undefined);
  await ctx.editMessageText(
    [
      '♻️ <b>Release this number?</b>',
      '',
      `DID: <code>${number.phone_number}</code>`,
      number.assigned_user_id ? 'The user will be notified and loses the number immediately.' : '',
      '',
      'The route is removed first, then the number returns to AVAILABLE.',
    ]
      .filter(Boolean)
      .join('\n'),
    { parse_mode: 'HTML', reply_markup: confirmKeyboard(`a:nrelok:${numberId}`, `a:n:${numberId}`, '♻️ Release', '❌ Cancel') },
  );
}

export async function handleNumberReleaseConfirm(ctx: BotContext, numberId: string): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const number = await getNumberById(numberId);
  if (!number) return;

  await releaseNumber(numberId, {
    actorId: ctx.state.user?.id ?? 'admin',
    actorTelegramId: ctx.from?.id ?? null,
    actorType: 'ADMIN',
    reason: 'released by admin',
    requestId: ctx.state.requestId,
  });

  if (number.assigned_user_id) {
    await enqueueNotification({
      userId: number.assigned_user_id,
      kind: 'NUMBER_RELEASED',
      payload: { phoneNumber: number.phone_number },
      dedupeKey: `released:${numberId}:${Date.now()}`,
    });
  }

  await ctx.editMessageText('♻️ Number released back to inventory.', {
    reply_markup: new InlineKeyboard().text('☎️ Numbers', 'a:numbers').row().text('🛠 Admin', 'a:home'),
  });
}

/**
 * Removes every AVAILABLE number from the inventory (spec §17).
 *
 * The confirmation screen states exactly what goes and what stays, because a
 * bulk action is the one place where "are you sure" deserves real numbers.
 * Numbers held by users are never touched: freeing one is a release, and doing
 * it silently inside a wipe would cut off a working endpoint.
 */
export async function handleNumbersWipeStart(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const preview = await inventoryRemovalPreview();

  if (preview.available === 0) {
    await ctx.editMessageText(['🗑 <b>Nothing to remove</b>', '', 'There is no AVAILABLE number in the inventory.'].join('\n'), {
      parse_mode: 'HTML',
      reply_markup: new InlineKeyboard().text('☎️ Numbers', 'a:numbers').row().text('🛠 Admin Panel', 'a:home'),
    });
    return;
  }

  await ctx.editMessageText(
    [
      '🗑 <b>Remove all available numbers?</b>',
      '',
      `🟢 Available (will be removed): <b>${preview.available}</b>`,
      `📞 Assigned (kept): ${preview.assigned}`,
      `⚠️ Suspended (kept): ${preview.suspended}`,
      `⏳ Reserved (kept): ${preview.reserved}`,
      '',
      'Numbers a user holds are never removed — release them first if you want them gone.',
      'Their route rows are closed and the inventory rows are soft-deleted, so the DID history stays auditable.',
    ].join('\n'),
    {
      parse_mode: 'HTML',
      reply_markup: confirmKeyboard('a:nwipeok', 'a:numbers', `🗑 Remove ${preview.available}`, '❌ Cancel'),
    },
  );
}

export async function handleNumbersWipeConfirm(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const actorId = ctx.state.user?.id ?? 'admin';
  try {
    const { removed, kept } = await removeAllAvailableNumbers({ actorId, requestId: ctx.state.requestId });
    // Every AVAILABLE number just went away; their detail screens cannot render.
    if (removed > 0) dropNavMatching(ctx, (data) => /^a:n:[0-9a-f-]{36}$/.test(data));
    await ctx.editMessageText(
      [
        `🗑 <b>${removed} number(s) removed</b>`,
        '',
        kept.assigned > 0 || kept.suspended > 0 || kept.reserved > 0
          ? `Kept: 📞 ${kept.assigned} assigned, ⚠️ ${kept.suspended} suspended, ⏳ ${kept.reserved} reserved.`
          : 'Every held number was left untouched.',
      ].join('\n'),
      {
        parse_mode: 'HTML',
        reply_markup: new InlineKeyboard().text('☎️ Numbers', 'a:numbers').row().text('🛠 Admin Panel', 'a:home'),
      },
    );
  } catch (err) {
    await ctx.editMessageText(['❌ <b>Nothing removed</b>', '', toAppError(err).userMessage].join('\n'), {
      parse_mode: 'HTML',
      reply_markup: new InlineKeyboard().text('☎️ Numbers', 'a:numbers').row().text('🛠 Admin Panel', 'a:home'),
    });
  }
}

export async function handleNumberDelete(ctx: BotContext, numberId: string): Promise<void> {
  const number = await getNumberById(numberId);
  if (!number) return;
  await ctx.answerCallbackQuery().catch(() => undefined);
  await ctx.editMessageText(
    [
      '🗑 <b>Delete this number from inventory?</b>',
      '',
      `DID: <code>${number.phone_number}</code>`,
      `Status: ${number.status}`,
      number.assigned_user_id ? '⚠️ It is currently assigned — release it first.' : '',
      '',
      'This only removes it from our inventory; the DID remains leased from your provider.',
    ]
      .filter(Boolean)
      .join('\n'),
    { parse_mode: 'HTML', reply_markup: confirmKeyboard(`a:ndelok:${numberId}`, `a:n:${numberId}`, '🗑 Delete', '❌ Cancel') },
  );
}

export async function handleNumberDeleteConfirm(ctx: BotContext, numberId: string): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  try {
    await deleteNumber(numberId, { actorId: ctx.state.user?.id ?? 'admin', requestId: ctx.state.requestId });
    dropNavMatching(ctx, (data) => data.includes(numberId));
    await ctx.editMessageText('🗑 Number deleted from inventory.', {
      reply_markup: new InlineKeyboard().text('☎️ Numbers', 'a:numbers').row().text('🛠 Admin', 'a:home'),
    });
  } catch (err) {
    await ctx.editMessageText(['❌ <b>Not deleted</b>', '', toAppError(err).userMessage].join('\n'), {
      parse_mode: 'HTML',
      reply_markup: new InlineKeyboard().text('⬅️ Back', `a:n:${numberId}`),
    });
  }
}

export async function handleNumberResync(ctx: BotContext, numberId: string): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  await ctx.editMessageText('🔄 Re-applying the inbound route…', { reply_markup: new InlineKeyboard() });
  try {
    const number = await getNumberById(numberId);
    if (!number) return;
    const { applyInboundRoute } = await import('../../services/routing.service.js');
    if (!number.sip_extension) throw new Error('No extension recorded for this number');

    await applyInboundRoute({
      numberId,
      assignmentId: null,
      didPattern: number.did_match_pattern ?? number.phone_number.replace('+', ''),
      extension: number.sip_extension,
      description: `manual resync ${new Date().toISOString()}`,
    });
    await ctx.editMessageText('✅ Route re-applied and verified against the PBX.', {
      reply_markup: new InlineKeyboard().text('📞 Number', `a:n:${numberId}`).row().text('🛠 Admin', 'a:home'),
    });
  } catch (err) {
    await ctx.editMessageText(['❌ <b>Re-sync failed</b>', '', toAppError(err).userMessage].join('\n'), {
      parse_mode: 'HTML',
      reply_markup: new InlineKeyboard().text('⬅️ Back', `a:n:${numberId}`),
    });
  }
}

export async function handleNumberReassignStart(ctx: BotContext, numberId: string): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const { rows } = await listUsers({ status: 'ACTIVE', limit: 10 });
  // numberId + userId would be 84 bytes of callback data (limit: 64), so the
  // number waits in the session while the admin picks the user.
  ctx.session.assignTarget = { numberId, mode: 'REASSIGN' };
  const kb = new InlineKeyboard();
  for (const user of rows) kb.text(`👤 ${user.username ?? user.telegram_id}`, `a:nreasok:${user.id}`).row();
  kb.text('⬅️ Back', `a:n:${numberId}`);

  await ctx.editMessageText(
    ['🔀 <b>Reassign number</b>', '', 'Choose the user who should receive this number.', '', 'The current holder’s route is removed first, then the new route is created.'].join('\n'),
    { parse_mode: 'HTML', reply_markup: kb },
  );
}

export async function handleNumberReassignConfirm(ctx: BotContext, toUserId: string): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const numberId = ctx.session.assignTarget?.numberId;
  if (!numberId) throw new Error('Pick the number again: the selection expired.');
  await ctx.editMessageText('🔄 Reassigning — releasing the old route first…', { reply_markup: new InlineKeyboard() });

  try {
    const result = await reassignNumber(numberId, toUserId, {
      actorId: ctx.state.user?.id ?? 'admin',
      actorTelegramId: ctx.from?.id ?? null,
      reason: 'reassigned by admin',
      requestId: ctx.state.requestId,
    });

    await enqueueNotification({
      userId: toUserId,
      kind: 'NUMBER_ASSIGNED',
      payload: { phoneNumber: result.phoneNumber, extension: result.extension },
      dedupeKey: `assigned:${numberId}:${toUserId}:${Date.now()}`,
    });

    await ctx.editMessageText(
      ['✅ <b>Number reassigned</b>', '', `📞 <code>${result.phoneNumber}</code> → extension <code>${result.extension}</code>`, '', 'The new route is live and the old route was removed.'].join('\n'),
      { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('📞 Number', `a:n:${numberId}`).row().text('🛠 Admin', 'a:home') },
    );
  } catch (err) {
    await ctx.editMessageText(['❌ <b>Reassignment failed</b>', '', toAppError(err).userMessage, '', 'The number was released back to AVAILABLE so nothing is inconsistent.'].join('\n'), {
      parse_mode: 'HTML',
      reply_markup: new InlineKeyboard().text('📞 Number', `a:n:${numberId}`),
    });
  }
}

export async function handleNumberAssignStart(ctx: BotContext, numberId: string): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const { rows } = await listUsers({ status: 'ACTIVE', limit: 10 });
  ctx.session.assignTarget = { numberId, mode: 'ASSIGN' };
  const kb = new InlineKeyboard();
  for (const user of rows) kb.text(`👤 ${user.username ?? user.telegram_id}`, `a:nassignok:${user.id}`).row();
  kb.text('⬅️ Back', `a:n:${numberId}`);

  await ctx.editMessageText(['👤 <b>Assign number</b>', '', 'Choose the user who should receive this number.'].join('\n'), { parse_mode: 'HTML', reply_markup: kb });
}

export async function handleNumberAssignConfirm(ctx: BotContext, toUserId: string): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const numberId = ctx.session.assignTarget?.numberId;
  if (!numberId) throw new Error('Pick the number again: the selection expired.');
  try {
    const result = await reassignNumber(numberId, toUserId, {
      actorId: ctx.state.user?.id ?? 'admin',
      actorTelegramId: ctx.from?.id ?? null,
      reason: 'assigned by admin',
      requestId: ctx.state.requestId,
    });
    await enqueueNotification({
      userId: toUserId,
      kind: 'NUMBER_ASSIGNED',
      payload: { phoneNumber: result.phoneNumber, extension: result.extension },
      dedupeKey: `assigned:${numberId}:${toUserId}:${Date.now()}`,
    });
    await ctx.editMessageText(`✅ Assigned <code>${result.phoneNumber}</code> to the user (extension <code>${result.extension}</code>).`, {
      parse_mode: 'HTML',
      reply_markup: new InlineKeyboard().text('📞 Number', `a:n:${numberId}`).row().text('🛠 Admin', 'a:home'),
    });
  } catch (err) {
    await ctx.editMessageText(['❌ ' + toAppError(err).userMessage].join('\n'), { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('⬅️ Back', `a:n:${numberId}`) });
  }
}

/** Country chosen earlier in the add-numbers / CSV wizard (session state). */
async function wizardCountry(ctx: BotContext, kind: 'ADD' | 'CSV'): Promise<string> {
  const countryId = ctx.session.numberWizard?.kind === kind ? ctx.session.numberWizard.countryId : undefined;
  if (!countryId) throw new Error('Choose the country again: the selection expired.');
  return countryId;
}

// -----------------------------------------------------------------------------
// Number import (spec §11)
// -----------------------------------------------------------------------------

export async function handleNumberAddStart(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const countries = await listCountries({ activeOnly: true });
  const kb = new InlineKeyboard();
  for (const c of countries.slice(0, 20)) kb.text(`${c.flag ?? '🌍'} ${c.name}`, `a:nacountry:${c.id}`).row();
  kb.text('🛠 Admin Panel', 'a:home').row();

  await ctx.editMessageText(['➕ <b>Add numbers</b>', '', 'Step 1/3 — choose the country.'].join('\n'), {
    parse_mode: 'HTML',
    reply_markup: withBack(kb),
  });
}

export async function handleNumberAddCountry(ctx: BotContext, countryId: string): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const services = await listServices({ activeOnly: true });
  const kb = new InlineKeyboard();
  ctx.session.numberWizard = { kind: 'ADD', countryId };
  for (const s of services.slice(0, 20)) kb.text(`${s.icon ?? '📱'} ${s.name}`, `a:naservice:${s.id}`).row();
  kb.text('⬅️ Back', 'a:nadd');

  await ctx.editMessageText(['➕ <b>Add numbers</b>', '', 'Step 2/3 — choose the service.'].join('\n'), { parse_mode: 'HTML', reply_markup: kb });
}

export async function handleNumberAddService(ctx: BotContext, serviceId: string): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const countryId = await wizardCountry(ctx, 'ADD');
  ctx.session.numberWizard = { kind: 'ADD', countryId, serviceId };
  const kb = new InlineKeyboard()
    .text('🆓 Free', `a:naplan:${serviceId}:FREE`)
    .text('💎 Premium', `a:naplan:${serviceId}:PREMIUM`)
    .row()
    .text('⬅️ Back', `a:nacountry:${countryId}`);

  await ctx.editMessageText(['➕ <b>Add numbers</b>', '', 'Step 3/3 — choose the plan type for these numbers.'].join('\n'), { parse_mode: 'HTML', reply_markup: kb });
}

export async function handleNumberAddPlan(ctx: BotContext, serviceId: string, planType: 'FREE' | 'PREMIUM'): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const countryId = await wizardCountry(ctx, 'ADD');
  const country = await getCountry(countryId);
  const service = await getService(serviceId);

  ctx.session.step = { type: 'admin_add_numbers', countryId, serviceId, planType };

  await ctx.editMessageText(
    [
      '➕ <b>Add numbers</b>',
      '',
      `🌍 ${country?.flag ?? ''} ${country?.name}`,
      `📱 ${service?.icon ?? ''} ${service?.name}`,
      `💎 ${planType === 'FREE' ? 'Free' : 'Premium'}`,
      '',
      'Send the numbers now — one per line, or comma separated.',
      `Example: <code>+${country?.dial_code ?? '971'}501234567</code>`,
      '',
      'Duplicates and invalid entries are rejected and reported back to you.',
      '',
      'Type /cancel to abort.',
    ].join('\n'),
    { parse_mode: 'HTML', reply_markup: withBack(new InlineKeyboard().text('❌ Cancel', 'a:numbers')) },
  );
}

export async function handleNumberAddInput(ctx: BotContext, text: string): Promise<void> {
  const step = ctx.session.step;
  if (!step || step.type !== 'admin_add_numbers') return;
  ctx.session.step = undefined;

  const values = text
    .split(/[\n,;]+/)
    .map((v) => v.trim())
    .filter(Boolean);

  await ctx.reply(`⏳ Importing ${values.length} number(s)…`);

  try {
    const result = await importNumbers({
      countryId: step.countryId,
      serviceId: step.serviceId,
      planType: step.planType,
      numbers: values,
      actorId: ctx.state.user?.id ?? 'admin',
      actorTelegramId: ctx.from?.id ?? null,
      source: values.length === 1 ? 'SINGLE' : 'BULK',
    });

    const lines = [
      '📥 <b>Import finished</b>',
      '',
      `✅ Imported: <b>${result.imported}</b>`,
      `⚠️ Duplicate: ${result.duplicates}`,
      `❌ Invalid: ${result.invalid}`,
      result.skippedAssigned > 0 ? `🔒 Already assigned (left untouched): ${result.skippedAssigned}` : '',
    ].filter(Boolean);

    if (result.errors.length > 0) {
      lines.push('', '<b>Rejected rows</b>');
      for (const e of result.errors.slice(0, 10)) lines.push(`• <code>${e.value}</code> — ${e.reason}`);
      if (result.errors.length > 10) lines.push(`…and ${result.errors.length - 10} more.`);
    }

    await ctx.reply(lines.join('\n'), {
      parse_mode: 'HTML',
      reply_markup: withBack(
        new InlineKeyboard().text('☎️ Inventory', 'a:nlist:AVAILABLE:0').text('➕ Add more', 'a:nadd').row().text('🛠 Admin Panel', 'a:home'),
      ),
    });
  } catch (err) {
    await ctx.reply(['❌ <b>Import failed</b>', '', toAppError(err).userMessage].join('\n'), {
      parse_mode: 'HTML',
      reply_markup: withBack(new InlineKeyboard().text('☎️ Numbers', 'a:numbers')),
    });
  }
}

export async function handleNumberCsvStart(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const countries = await listCountries({ activeOnly: true });
  const kb = new InlineKeyboard();
  for (const c of countries.slice(0, 20)) kb.text(`${c.flag ?? '🌍'} ${c.name}`, `a:ncscountry:${c.id}`).row();
  kb.text('⬅️ Back', 'a:numbers');

  await ctx.editMessageText(
    ['📄 <b>CSV import</b>', '', 'Step 1/3 — choose the country these numbers belong to.', '', '<i>A header row "phone_number" is optional and will be ignored.</i>'].join('\n'),
    { parse_mode: 'HTML', reply_markup: kb },
  );
}

export async function handleNumberCsvCountry(ctx: BotContext, countryId: string): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const services = await listServices({ activeOnly: true });
  const kb = new InlineKeyboard();
  ctx.session.numberWizard = { kind: 'CSV', countryId };
  for (const s of services.slice(0, 20)) kb.text(`${s.icon ?? '📱'} ${s.name}`, `a:ncsservice:${s.id}`).row();
  kb.text('⬅️ Back', 'a:ncsv');

  await ctx.editMessageText(['📄 <b>CSV import</b>', '', 'Step 2/3 — choose the service.'].join('\n'), { parse_mode: 'HTML', reply_markup: kb });
}

export async function handleNumberCsvService(ctx: BotContext, serviceId: string): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const countryId = await wizardCountry(ctx, 'CSV');
  ctx.session.numberWizard = { kind: 'CSV', countryId, serviceId };
  const kb = new InlineKeyboard()
    .text('🆓 Free', `a:ncsplan:${serviceId}:FREE`)
    .text('💎 Premium', `a:ncsplan:${serviceId}:PREMIUM`)
    .row()
    .text('⬅️ Back', `a:ncscountry:${countryId}`);

  await ctx.editMessageText(['📄 <b>CSV import</b>', '', 'Step 3/3 — choose the plan type.'].join('\n'), { parse_mode: 'HTML', reply_markup: kb });
}

export async function handleNumberCsvPlan(ctx: BotContext, serviceId: string, planType: 'FREE' | 'PREMIUM'): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const countryId = await wizardCountry(ctx, 'CSV');
  const country = await getCountry(countryId);
  const service = await getService(serviceId);
  ctx.session.step = { type: 'admin_csv_import', countryId, serviceId, planType };

  await ctx.editMessageText(
    [
      '📄 <b>CSV import</b>',
      '',
      `🌍 ${country?.flag ?? ''} ${country?.name} · 📱 ${service?.icon ?? ''} ${service?.name} · ${planType}`,
      '',
      'Now send the CSV content as a message, or upload a <code>.csv</code> file.',
      '',
      'Accepted format:',
      '<code>phone_number\n+' + (country?.dial_code ?? '971') + '501234567\n+' + (country?.dial_code ?? '971') + '509876543</code>',
      '',
      'Type /cancel to abort.',
    ].join('\n'),
    { parse_mode: 'HTML', reply_markup: withBack(new InlineKeyboard().text('❌ Cancel', 'a:numbers')) },
  );
}

export async function handleNumberCsvInput(ctx: BotContext, csvText: string, originalName?: string): Promise<void> {
  const step = ctx.session.step;
  if (!step || step.type !== 'admin_csv_import') return;
  ctx.session.step = undefined;

  await ctx.reply('⏳ Parsing and importing…');
  try {
    const result = await importNumbers({
      countryId: step.countryId,
      serviceId: step.serviceId,
      planType: step.planType,
      csvText,
      actorId: ctx.state.user?.id ?? 'admin',
      actorTelegramId: ctx.from?.id ?? null,
      source: 'CSV',
      originalName: originalName ?? null,
    });

    const lines = [
      '📥 <b>CSV import finished</b>',
      '',
      `Rows read: ${result.totalRows}`,
      `✅ Imported: <b>${result.imported}</b>`,
      `⚠️ Duplicate: ${result.duplicates}`,
      `❌ Invalid: ${result.invalid}`,
      result.skippedAssigned > 0 ? `🔒 Already assigned (untouched): ${result.skippedAssigned}` : '',
    ].filter(Boolean);

    if (result.errors.length > 0) {
      lines.push('', '<b>Rejected rows (first 10)</b>');
      for (const e of result.errors.slice(0, 10)) lines.push(`• row ${e.row}: <code>${e.value}</code> — ${e.reason}`);
    }

    await ctx.reply(lines.join('\n'), {
      parse_mode: 'HTML',
      reply_markup: withBack(
        new InlineKeyboard().text('☎️ Inventory', 'a:nlist:AVAILABLE:0').text('📄 Import again', 'a:ncsv').row().text('🛠 Admin Panel', 'a:home'),
      ),
    });
  } catch (err) {
    await ctx.reply(['❌ <b>Import failed</b>', '', toAppError(err).userMessage].join('\n'), {
      parse_mode: 'HTML',
      reply_markup: withBack(new InlineKeyboard().text('☎️ Numbers', 'a:numbers')),
    });
  }
}

export async function handleImportBatches(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const batches = await listImportBatches(5);
  const lines = ['📥 <b>Recent imports</b>', ''];
  if (batches.length === 0) lines.push('No imports yet.');
  for (const b of batches as Array<Record<string, unknown>>) {
    lines.push(
      `• ${String(b['country_name'] ?? '')} / ${String(b['service_name'] ?? '')} — ✅${b['imported_count']} ⚠️${b['duplicate_count']} ❌${b['invalid_count']} (${String(b['created_at']).slice(0, 16)})`,
    );
  }
  await ctx.editMessageText(lines.join('\n'), {
    parse_mode: 'HTML',
    reply_markup: withBack(new InlineKeyboard().text('☎️ Numbers', 'a:numbers')),
  });
}

// -----------------------------------------------------------------------------
// Routes overview
// -----------------------------------------------------------------------------

export async function handleRoutesOverview(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const rows = await many<{ did_match_pattern: string; destination: string; status: string; drift_state: string | null; freepbx_route_id: string | null }>(
    `SELECT did_match_pattern, destination, status, drift_state, freepbx_route_id
       FROM inbound_route_mappings WHERE deleted_at IS NULL AND status <> 'REMOVED'
      ORDER BY created_at DESC LIMIT 15`,
  );

  const lines = ['🔗 <b>DID → SIP routes</b>', ''];
  if (rows.length === 0) lines.push('No routes yet.');
  for (const r of rows) {
    const drift = r.drift_state && r.drift_state !== 'OK' ? ` ⚠️${r.drift_state}` : '';
    lines.push(`<code>${r.did_match_pattern}</code> → <code>${r.destination}</code> (${r.status})${drift}`);
  }

  await ctx.editMessageText(lines.join('\n'), {
    parse_mode: 'HTML',
    reply_markup: withBack(new InlineKeyboard().text('🔄 Run reconciliation', 'a:runsync').row().text('☎️ Numbers', 'a:numbers')),
  });
}

// -----------------------------------------------------------------------------
// Services / Countries / Plans (spec §25, §26, §22)
// -----------------------------------------------------------------------------

export async function handleServicesMenu(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const services = await listServices();
  await ctx.editMessageText(['📱 <b>Services</b>', '', `${services.length} service(s).`].join('\n'), { parse_mode: 'HTML', reply_markup: servicesKeyboard(services) });
}

export async function handleServiceDetail(ctx: BotContext, serviceId: string): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const service = await getService(serviceId);
  if (!service) {
    await renderGoneScreen(ctx, '📱 <b>Service no longer available</b>', 'a:services', '📱 Services');
    return;
  }

  const numbers = await countNumbersByStatus();
  await ctx.editMessageText(
    [
      '📱 <b>Service</b>',
      '',
      `Name: ${service.icon ?? ''} ${service.name}`,
      `Slug: <code>${service.slug}</code>`,
      `Description: ${service.description ?? '—'}`,
      `Status: ${service.status}`,
      '',
      `Inventory in the system: ${numbers.TOTAL ?? 0} numbers overall`,
    ].join('\n'),
    { parse_mode: 'HTML', reply_markup: serviceDetailKeyboard(serviceId, service.status) },
  );
}

export async function handleServiceToggle(ctx: BotContext, serviceId: string): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const service = await getService(serviceId);
  if (!service) return handleServiceDetail(ctx, serviceId);
  await updateService(serviceId, { status: service.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE' });
  await handleServiceDetail(ctx, serviceId);
}

export async function handleServiceEditStart(ctx: BotContext, serviceId: string, field: 'name' | 'icon' | 'description'): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  ctx.session.step = { type: 'admin_edit_service', serviceId, field };
  await ctx.editMessageText(['✏️ Send the new value for <b>' + field + '</b>.', '', 'Type /cancel to abort.'].join('\n'), {
    parse_mode: 'HTML',
    reply_markup: new InlineKeyboard().text('❌ Cancel', `a:svc:${serviceId}`),
  });
}

export async function handleServiceAddStart(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  ctx.session.step = { type: 'admin_add_service' };
  await ctx.editMessageText(
    ['➕ <b>New service</b>', '', 'Send the name, optionally with an emoji icon.', 'Example: <code>💬 WhatsApp</code>', '', 'Type /cancel to abort.'].join('\n'),
    { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('❌ Cancel', 'a:services') },
  );
}

/**
 * Removing a service: preview first, then confirm (spec §9).
 *
 * The impact is spelled out because removal takes the service's AVAILABLE
 * numbers with it. A service a user is currently using cannot be removed -
 * disabling it is offered instead, which keeps their numbers working.
 */
export async function handleServiceDelete(ctx: BotContext, serviceId: string): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const service = await getService(serviceId);
  if (!service) {
    await ctx.editMessageText('❌ Service not found.', {
      reply_markup: new InlineKeyboard().text('⬅️ Services', 'a:services'),
    });
    return;
  }
  const impact = await serviceRemovalImpact(serviceId);

  if (impact.assignedNumbers > 0) {
    await ctx.editMessageText(
      [
        `⚠️ <b>Remove ${service.icon ?? ''} ${service.name} and revoke its numbers?</b>`,
        '',
        `☎️ In use right now: <b>${impact.assignedNumbers}</b> number(s) held by <b>${impact.affectedUsers}</b> user(s).`,
        `♻️ Available numbers removed with it: ${impact.availableNumbers}`,
        `🔗 Offers removed: ${impact.offers}`,
        '',
        'Removing the service takes those numbers back from their holders: each number is removed from the account, its inbound route is deleted, and the number is retired. The holders are notified.',
      ].join('\n'),
      {
        parse_mode: 'HTML',
        reply_markup: new InlineKeyboard()
          .text('🗑 Remove and revoke', `a:svcdelok:${serviceId}`)
          .row()
          .text('🔴 Disable instead', `a:svct:${serviceId}`)
          .row()
          .text('⬅️ Service', `a:svc:${serviceId}`)
          .row()
          .text('⬅️ Services', 'a:services'),
      },
    );
    return;
  }

  await ctx.editMessageText(
    [
      `🗑 <b>Remove ${service.icon ?? ''} ${service.name}?</b>`,
      '',
      `📦 Available numbers removed with it: <b>${impact.availableNumbers}</b>`,
      `🔗 Offers removed: ${impact.offers}`,
      '',
      'Users are unaffected: no number of this service is assigned. The service is soft-deleted, so its history stays auditable.',
    ].join('\n'),
    { parse_mode: 'HTML', reply_markup: confirmKeyboard(`a:svcdelok:${serviceId}`, `a:svc:${serviceId}`, '🗑 Remove', '❌ Cancel') },
  );
}

export async function handleServiceDeleteConfirm(ctx: BotContext, serviceId: string): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  try {
    const impact = await deleteService(serviceId, {
      actorId: ctx.state.user?.id ?? 'admin',
      requestId: ctx.state.requestId,
      force: true,
    });
    dropNavMatching(ctx, (data) => data.includes(serviceId));
    await ctx.editMessageText(
      [
        '🗑 Service removed.',
        '',
        `📦 Numbers removed: ${impact.availableNumbers}`,
        impact.revokedNumbers > 0
          ? `☎️ ${impact.revokedNumbers} number(s) revoked from ${impact.affectedUsers} user(s) — they were notified.`
          : '',
        `🔗 Offers removed: ${impact.offers}`,
      ]
        .filter(Boolean)
        .join('\n'),
      {
        parse_mode: 'HTML',
        reply_markup: withBack(
          new InlineKeyboard().text('⬅️ Services', 'a:services').row().text('🛠 Admin Panel', 'a:home'),
        ),
      },
    );
  } catch (err) {
    await ctx.editMessageText(['❌ <b>Not removed</b>', '', toAppError(err).userMessage].join('\n'), {
      parse_mode: 'HTML',
      reply_markup: new InlineKeyboard().text('⬅️ Service', `a:svc:${serviceId}`).row().text('⬅️ Services', 'a:services'),
    });
  }
}

/**
 * The screen shown when the entity a screen described is no longer there.
 * Every screen must render something and offer a way out - a handler that
 * returned silently made Back look broken (reported from live use).
 */
async function renderGoneScreen(ctx: BotContext, title: string, listData: string, listLabel: string): Promise<void> {
  await ctx.editMessageText([title, '', 'It was removed from the catalogue.'].join('\n'), {
    parse_mode: 'HTML',
    reply_markup: withBack(new InlineKeyboard().text(listLabel, listData).row().text('🛠 Admin Panel', 'a:home')),
  });
}

export async function handleCountriesMenu(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const countries = await listCountries();
  await ctx.editMessageText(['🌍 <b>Countries</b>', '', `${countries.length} configured.`].join('\n'), { parse_mode: 'HTML', reply_markup: countriesKeyboard(countries) });
}

export async function handleCountryDetail(ctx: BotContext, countryId: string): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const country = await getCountry(countryId);
  if (!country) {
    // Reached through Back on a screen for a country that has since been
    // removed. Saying nothing would look like a broken button.
    await renderGoneScreen(ctx, '🌍 <b>Country no longer available</b>', 'a:countries', '🌍 Countries');
    return;
  }
  await ctx.editMessageText(
    ['🌍 <b>Country</b>', '', `Name: ${country.name}`, `ISO2: ${country.iso2}`, `Dial code: +${country.dial_code}`, `Flag: ${country.flag ?? '—'}`, `Status: ${country.status}`].join('\n'),
    { parse_mode: 'HTML', reply_markup: countryDetailKeyboard(countryId, country.status) },
  );
}

export async function handleCountryToggle(ctx: BotContext, countryId: string): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const country = await getCountry(countryId);
  if (!country) return handleCountryDetail(ctx, countryId);
  await updateCountry(countryId, { status: country.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE' });
  await handleCountryDetail(ctx, countryId);
}

/**
 * Removing a country: preview first, then confirm (spec §8).
 *
 * Removal takes the country's AVAILABLE numbers and its offers with it. A
 * country with numbers in use cannot be removed while they are live.
 */
export async function handleCountryDelete(ctx: BotContext, countryId: string): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const country = await getCountry(countryId);
  if (!country) {
    await ctx.editMessageText('❌ Country not found.', {
      reply_markup: new InlineKeyboard().text('⬅️ Countries', 'a:countries'),
    });
    return;
  }
  const impact = await countryRemovalImpact(countryId);

  if (impact.assignedNumbers > 0) {
    // Removing is allowed - it just has to say what it takes with it. The
    // holder loses the number (route removed, number retired) and is notified.
    await ctx.editMessageText(
      [
        `⚠️ <b>Remove ${country.flag ?? ''} ${country.name} and revoke its numbers?</b>`,
        '',
        `☎️ In use right now: <b>${impact.assignedNumbers}</b> number(s) held by <b>${impact.affectedUsers}</b> user(s).`,
        `♻️ Available numbers removed with it: ${impact.availableNumbers}`,
        `🔗 Offers removed: ${impact.offers}`,
        '',
        'Removing the country takes those numbers back from their holders: each number is removed from the account, its inbound route is deleted, and the number is retired. The holders are notified.',
      ].join('\n'),
      {
        parse_mode: 'HTML',
        reply_markup: new InlineKeyboard()
          .text('🗑 Remove and revoke', `a:ctrydelok:${countryId}`)
          .row()
          .text('🔴 Disable instead', `a:ctryt:${countryId}`)
          .row()
          .text('⬅️ Country', `a:ctry:${countryId}`)
          .row()
          .text('⬅️ Countries', 'a:countries'),
      },
    );
    return;
  }

  await ctx.editMessageText(
    [
      `🗑 <b>Remove ${country.flag ?? ''} ${country.name}?</b>`,
      '',
      `📦 Available numbers removed with it: <b>${impact.availableNumbers}</b>`,
      `🔗 Offers removed: ${impact.offers}`,
      '',
      'Users are unaffected: no number of this country is assigned. The country is soft-deleted, so its history stays auditable.',
    ].join('\n'),
    { parse_mode: 'HTML', reply_markup: confirmKeyboard(`a:ctrydelok:${countryId}`, `a:ctry:${countryId}`, '🗑 Remove', '❌ Cancel') },
  );
}

export async function handleCountryDeleteConfirm(ctx: BotContext, countryId: string): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  try {
    // force: the admin saw the warning screen and confirmed - the numbers this
    // country still has in users' hands come back with it.
    const impact = await deleteCountry(countryId, {
      actorId: ctx.state.user?.id ?? 'admin',
      requestId: ctx.state.requestId,
      force: true,
    });
    // The country's own screens are stale now: drop them so Back (and any
    // leftover entry) lands on the list, never on a screen that cannot render.
    dropNavMatching(ctx, (data) => data.includes(countryId));
    await ctx.editMessageText(
      [
        '🗑 Country removed.',
        '',
        `📦 Numbers removed: ${impact.availableNumbers}`,
        impact.revokedNumbers > 0
          ? `☎️ ${impact.revokedNumbers} number(s) revoked from ${impact.affectedUsers} user(s) — they were notified.`
          : '',
        `🔗 Offers removed: ${impact.offers}`,
      ]
        .filter(Boolean)
        .join('\n'),
      {
        parse_mode: 'HTML',
        reply_markup: withBack(
          new InlineKeyboard().text('⬅️ Countries', 'a:countries').row().text('🛠 Admin Panel', 'a:home'),
        ),
      },
    );
  } catch (err) {
    await ctx.editMessageText(['❌ <b>Not removed</b>', '', toAppError(err).userMessage].join('\n'), {
      parse_mode: 'HTML',
      reply_markup: new InlineKeyboard().text('⬅️ Country', `a:ctry:${countryId}`).row().text('⬅️ Countries', 'a:countries'),
    });
  }
}

export async function handleCountryAddStart(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  ctx.session.step = { type: 'admin_add_country' };
  await ctx.editMessageText(
    ['➕ <b>New country</b>', '', 'Send: <code>Name | ISO2 | dialcode | flag</code>', '', 'Example: <code>United Arab Emirates | AE | 971 | 🇦🇪</code>', '', 'Type /cancel to abort.'].join('\n'),
    { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('❌ Cancel', 'a:countries') },
  );
}

export async function handleCountryEditStart(ctx: BotContext, countryId: string, field: 'name' | 'flag' | 'dial_code'): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  ctx.session.step = { type: 'admin_edit_country', countryId, field };
  await ctx.editMessageText(`✏️ Send the new value for <b>${field}</b>.`, { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('❌ Cancel', `a:ctry:${countryId}`) });
}

export async function handlePlansMenu(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const plans = await listPlans();
  const lines = ['💎 <b>Plans</b>', ''];
  for (const plan of plans) {
    lines.push(
      `${plan.is_default ? '⭐️ ' : ''}${plan.name} — max ${plan.max_numbers} number(s), ${plan.allows_premium_numbers ? 'premium ✅' : 'premium ❌'}, ${plan.price_cents_per_month > 0 ? formatMoney(plan.price_cents_per_month, plan.currency) : 'free'}/mo`,
    );
  }
  await ctx.editMessageText(lines.join('\n'), { parse_mode: 'HTML', reply_markup: plansKeyboard(plans) });
}

export async function handlePlanDetail(ctx: BotContext, planId: string): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const plans = await listPlans();
  const plan = plans.find((p) => p.id === planId);
  if (!plan) return;

  await ctx.editMessageText(
    [
      `💎 <b>${plan.name}</b>`,
      '',
      `Code: <code>${plan.code}</code>`,
      `Max numbers: ${plan.max_numbers}`,
      `Premium inventory: ${plan.allows_premium_numbers ? 'yes' : 'no'}`,
      `Price: ${formatMoney(plan.price_cents_per_month, plan.currency)} / ${plan.duration_days} days`,
      `Active: ${plan.is_active ? 'yes' : 'no'}${plan.is_default ? ' (default)' : ''}`,
      '',
      'All limits are enforced by the assignment service.',
    ].join('\n'),
    { parse_mode: 'HTML', reply_markup: planDetailKeyboard(planId) },
  );
}

export async function handlePlanAdjust(ctx: BotContext, planId: string, field: 'max' | 'premium' | 'price' | 'duration' | 'toggle', value?: number): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  if (field === 'max' && value) await updatePlan(planId, { maxNumbers: value });
  if (field === 'premium') {
    const plans = await listPlans();
    const plan = plans.find((p) => p.id === planId);
    if (plan) await updatePlan(planId, { allowsPremiumNumbers: !plan.allows_premium_numbers });
  }
  if (field === 'price' && value !== undefined) await updatePlan(planId, { priceCentsPerMonth: value });
  if (field === 'duration' && value) await updatePlan(planId, { durationDays: value });
  if (field === 'toggle') {
    const plans = await listPlans();
    const plan = plans.find((p) => p.id === planId);
    if (plan) await updatePlan(planId, { isActive: !plan.is_active });
  }
  await handlePlanDetail(ctx, planId);
}

// -----------------------------------------------------------------------------
// Calls (spec §20, §21)
// -----------------------------------------------------------------------------

export async function handleLiveCalls(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const status = await liveCallSourceStatus();
  const calls = await getLiveCalls();

  const lines = ['📞 <b>LIVE CALLS</b>', ''];
  if (!status.available) {
    lines.push('⚪️ <b>Live monitoring unavailable</b>', '', status.detail ?? 'AMI is not configured.');
  } else if (calls.length === 0) {
    lines.push('No active calls right now.');
  } else {
    for (const call of calls.slice(0, 12)) {
      lines.push(
        `👤 ${call.username ? `@${call.username}` : 'unmatched'} · 🔑 <code>${call.extension ?? '—'}</code>`,
        `📞 DID: <code>${maskNumber(call.did ?? '')}</code> · Caller: <code>${maskNumber(call.caller)}</code>`,
        `📶 ${call.state} · ${formatDuration(call.durationSeconds)} · ${call.direction}`,
        '',
      );
    }
  }

  lines.push(`<i>Source: Asterisk AMI (live). CDR is history only and is never used here.</i>`);

  await ctx.editMessageText(lines.join('\n'), {
    parse_mode: 'HTML',
    reply_markup: withBack(new InlineKeyboard().text('🔄 Refresh', 'a:live').row().text('🛠 Admin Panel', 'a:home')),
  });
}

export async function handleCallHistory(ctx: BotContext, page = 0): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const pageSize = 8;
  const { rows, total } = await getSystemCallHistory({ limit: pageSize, offset: page * pageSize });

  const lines = ['🗂 <b>Call history (all users)</b>', '', `${total} record(s).`, ''];
  if (rows.length === 0) lines.push('Nothing recorded yet. CDR is ingested from the PBX periodically.');
  for (const call of rows) {
    lines.push(
      `• <code>${maskNumber(call.src ?? '')}</code> → <code>${maskNumber(call.dst ?? '')}</code>`,
      `   ${formatDateTime(call.calldate)} · ${formatDuration(call.billsec)} · ${call.disposition ?? '—'} · ${call.direction ?? '—'}${call.username ? ` · @${call.username}` : ''}`,
    );
  }

  const pages = Math.max(1, Math.ceil(total / pageSize));
  const kb = new InlineKeyboard();
  if (page > 0) kb.text('⬅️ Newer', `a:calls:${page - 1}`);
  kb.text(`${page + 1}/${pages}`, 'noop');
  if (page < pages - 1) kb.text('Older ➡️', `a:calls:${page + 1}`);
  kb.row().text('🛠 Admin Panel', 'a:home');

  await ctx.editMessageText(lines.join('\n'), { parse_mode: 'HTML', reply_markup: withBack(kb) });
}

// -----------------------------------------------------------------------------
// Referrals (spec §23)
// -----------------------------------------------------------------------------

export async function handleReferralsAdmin(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const summary = await getReferralProgramSummary();
  const cfg = await getAllSettings();
  const value = (key: string) => cfg.find((s) => s.key === key)?.value;

  await ctx.editMessageText(
    [
      '💰 <b>Referrals</b>',
      '',
      `Enabled: ${value('referral.enabled') ? 'yes' : 'no'}`,
      `Commission: ${value('referral.commission_type')} / ${value('referral.commission_value')}`,
      `Qualification: ${value('referral.qualification_rule')}`,
      '',
      `Total referrals: ${summary.totalReferrals}`,
      `Qualified: ${summary.qualified}`,
      `Pending payout: ${formatMoney(summary.pendingCommissionsCents)}`,
      `Paid: ${formatMoney(summary.paidCents)}`,
    ].join('\n'),
    { parse_mode: 'HTML', reply_markup: referralsAdminKeyboard() },
  );
}

export async function handleTopReferrers(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const summary = await getReferralProgramSummary();
  await ctx.editMessageText(
    ['🏆 <b>Top referrers</b>', '', ...summary.topReferrers.map((r, i) => `${i + 1}. ${r.username ? `@${r.username}` : 'user'} — ${r.qualified} qualified · ${formatMoney(r.earned_cents)}`)].join('\n'),
    { parse_mode: 'HTML', reply_markup: referrerListKeyboard(summary.topReferrers) },
  );
}

export async function handlePayoutQueue(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const rows = await listPendingCommissions(8);
  const lines = ['💸 <b>Payout queue</b>', '', 'Commissions past their hold period.', ''];
  if (rows.length === 0) lines.push('Nothing waiting.');

  const kb = new InlineKeyboard();
  for (const c of rows) {
    lines.push(`• ${c.username ? `@${c.username}` : 'user'} — ${formatMoney(c.amount_cents, c.currency)} (${Math.round(Number(c.age_hours))}h old)`);
    kb.text(`✅ ${c.username ?? 'user'} ${formatMoney(c.amount_cents, c.currency)}`, `a:cmpayask:${c.id}`).row();
  }
  kb.text('💰 Referrals', 'a:ref').row();

  await ctx.editMessageText(lines.join('\n'), { parse_mode: 'HTML', reply_markup: withBack(kb) });
}

export async function handleCommissionPayPrompt(ctx: BotContext, commissionId: string): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  await ctx.editMessageText('💸 <b>Mark this commission as paid?</b>', {
    parse_mode: 'HTML',
    reply_markup: confirmKeyboard(`a:cmpay:${commissionId}`, 'a:refpay', '✅ Mark paid', '❌ Cancel'),
  });
}

export async function handleCommissionPay(ctx: BotContext, commissionId: string): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  await markCommissionPaid(commissionId, ctx.state.user?.id ?? 'admin');
  await ctx.editMessageText('✅ Commission marked as paid.', {
    reply_markup: withBack(new InlineKeyboard().text('💸 Payout queue', 'a:refpay')),
  });
}

export async function handleCommissionReject(ctx: BotContext, commissionId: string): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const rows = await listPendingCommissions(20);
  const commission = rows.find((c) => c.id === commissionId);
  if (!commission) {
    await ctx.answerCallbackQuery('Commission not found.').catch(() => undefined);
    return;
  }
  // Rejecting a commission also rejects the underlying referral (anti-fraud).
  const referral = await many<{ id: string }>('SELECT id FROM referrals WHERE referrer_user_id = $1 AND status = $2 LIMIT 1', [
    commission.referrer_user_id,
    'QUALIFIED',
  ]);
  if (referral[0]) await rejectReferral(referral[0].id, 'rejected by admin', ctx.state.user?.id ?? 'admin').catch(() => undefined);

  await ctx.editMessageText('🚫 Commission reversed.', {
    reply_markup: withBack(new InlineKeyboard().text('💸 Payout queue', 'a:refpay')),
  });
}

// -----------------------------------------------------------------------------
// Settings (spec §22, §45)
// -----------------------------------------------------------------------------

export async function handleSettingsMenu(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const settings = await getAllSettings();
  const ed = settings.filter((s) => s.is_editable);
  const grouped = ed.slice(0, 12);

  await ctx.editMessageText(
    [
      '🔧 <b>Settings</b>',
      '',
      `${ed.length} editable settings. Tap one to change it — everything is applied without a restart.`,
      '',
      ...ed.slice(0, 12).map((s) => `• <b>${s.label}</b>: <code>${JSON.stringify(s.value).slice(0, 30)}</code>`),
      ed.length > 12 ? `…and ${ed.length - 12} more (use the API for bulk edits).` : '',
    ]
      .filter(Boolean)
      .join('\n'),
    { parse_mode: 'HTML', reply_markup: settingsKeyboard(grouped) },
  );
}

export async function handleSettingEditStart(ctx: BotContext, key: string): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const settings = await getAllSettings();
  const setting = settings.find((s) => s.key === key);
  if (!setting) return;

  ctx.session.step = { type: 'admin_set_setting', key, label: setting.label };
  await ctx.editMessageText(
    [
      `🔧 <b>${setting.label}</b>`,
      '',
      setting.description ?? '',
      '',
      `Current: <code>${JSON.stringify(setting.value)}</code>`,
      `Type: ${setting.value_type}`,
      '',
      'Send the new value.',
    ].join('\n'),
    { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('❌ Cancel', 'a:settings') },
  );
}

// -----------------------------------------------------------------------------
// Health / reconciliation / audit (spec §31, §38, §28)
// -----------------------------------------------------------------------------

export async function handleFindings(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const findings = await getOpenFindings(10);
  const lines = ['🚨 <b>Open findings</b>', ''];
  if (findings.length === 0) lines.push('✅ No open findings. The database and the PBX agree.');
  for (const f of findings as Array<Record<string, unknown>>) {
    const sev = f['severity'] === 'CRITICAL' ? '🔴' : f['severity'] === 'WARNING' ? '🟠' : '🔵';
    lines.push(`${sev} <b>${f['finding_type']}</b>`, `   ${String(f['detail']).slice(0, 200)}`, f['suggested_action'] ? `   💡 ${String(f['suggested_action']).slice(0, 160)}` : '');
  }
  await ctx.editMessageText(lines.filter(Boolean).join('\n'), { parse_mode: 'HTML', reply_markup: findingsKeyboard(findings as Array<{ id: string }>) });
}

export async function handleRunReconciliation(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery('Running reconciliation…').catch(() => undefined);
  await ctx.editMessageText('🔄 Comparing the database against FreePBX…', { reply_markup: new InlineKeyboard() });

  try {
    const summary = await runReconciliation({});
    const lines = [
      '🔄 <b>Reconciliation finished</b>',
      '',
      `Extensions seen: ${summary.extensionsSeen}`,
      `Routes seen: ${summary.routesSeen}`,
      `Findings: ${summary.findings} (🔴 ${summary.critical})`,
      `Auto-fixed: ${summary.autoFixed}`,
      '',
      ...summary.details.slice(0, 6).map((d) => `${d.severity === 'CRITICAL' ? '🔴' : d.severity === 'WARNING' ? '🟠' : '🔵'} ${d.detail.slice(0, 180)}`),
    ];
    await ctx.editMessageText(lines.join('\n'), { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('🚨 Findings', 'a:findings').row().text('🛠 Admin', 'a:home') });
  } catch (err) {
    await ctx.editMessageText(['❌ <b>Reconciliation failed</b>', '', (err as Error).message].join('\n'), {
      parse_mode: 'HTML',
      reply_markup: new InlineKeyboard().text('🛠 Admin', 'a:home'),
    });
  }
}

export async function handleResolveFinding(ctx: BotContext, findingId: string): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  await resolveFinding(findingId, ctx.state.user?.id ?? 'admin');
  await handleFindings(ctx);
}

export async function handleHealth(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const [dashboard, compat, ami, accounts] = await Promise.all([
    getDashboard(),
    getStoredCompatibilityReport(),
    liveCallSourceStatus(),
    listSipAccountsWithUser(3),
  ]);

  const lines = [
    '🩺 <b>System health</b>',
    '',
    '🗄 <b>Database</b>',
    `Latency: ${dashboard.health.dbLatencyMs}ms`,
    '',
    '🔌 <b>FreePBX</b>',
    `Mode: ${env.freepbx.mode}`,
    `Endpoint: ${env.freepbx.graphqlUrl || '—'}`,
    compat ? `Schema ok: ${compat['schemaOk'] ? '✅' : '⚠️'}` : 'Schema: not probed yet',
    compat && Array.isArray(compat['missing']) && (compat['missing'] as string[]).length > 0 ? `Missing ops: ${(compat['missing'] as string[]).join(', ')}` : '',
    compat ? `Detected: ${String(compat['detectedAt'] ?? '—').slice(0, 19)}` : '',
    '',
    '📞 <b>Live calls (AMI)</b>',
    `Status: ${ami.available ? '🟢 connected' : '⚪️ unavailable'}`,
    ami.detail ? `<i>${ami.detail.slice(0, 200)}</i>` : '',
    '',
    '⚙️ <b>Workers</b>',
    `Pending PBX jobs: ${dashboard.health.pendingPbxJobs}`,
    `Dead jobs: ${dashboard.health.deadPbxJobs}`,
    `Last reconciliation: ${dashboard.health.lastReconcileAt ? formatDateTime(dashboard.health.lastReconcileAt) : 'never'}`,
    `Last CDR sync: ${dashboard.health.lastCdrSyncAt ? formatDateTime(dashboard.health.lastCdrSyncAt) : 'never'}`,
    '',
    '🔑 <b>Recent SIP accounts</b>',
    ...accounts.map((a) => `• <code>${a.extension}</code> ${a.username ? `@${a.username}` : ''} (${a.status})`),
  ].filter(Boolean);

  await ctx.editMessageText(lines.join('\n'), { parse_mode: 'HTML', reply_markup: healthKeyboard() });
}

export async function handleProbePbx(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery('Probing…').catch(() => undefined);
  if (env.freepbx.mode === 'mock') {
    await ctx.editMessageText('ℹ️ FreePBX is running in <b>mock mode</b> - no real probe is possible.', {
      parse_mode: 'HTML',
      reply_markup: new InlineKeyboard().text('⬅️ Health', 'a:health'),
    });
    return;
  }
  try {
    const report = await runCompatibilityProbe(new FreePBXGraphQLClient());
    await ctx.editMessageText(
      [
        '🔌 <b>FreePBX probe</b>',
        '',
        `Schema ok: ${report.schemaOk ? '✅' : '⚠️'}`,
        `Supported operations: ${report.supported.length}`,
        report.missing.length > 0 ? `Missing: ${report.missing.join(', ')}` : 'Missing: none',
        report.asteriskVersion ? `Asterisk: ${report.asteriskVersion}` : '',
        '',
        ...report.notes.map((n) => `ℹ️ ${n.slice(0, 240)}`),
      ]
        .filter(Boolean)
        .join('\n'),
      { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('⬅️ Health', 'a:health') },
    );
  } catch (err) {
    await ctx.editMessageText(['❌ <b>Probe failed</b>', '', (err as Error).message].join('\n'), {
      parse_mode: 'HTML',
      reply_markup: new InlineKeyboard().text('⬅️ Health', 'a:health'),
    });
  }
}

export async function handleAuditLog(ctx: BotContext, page = 0): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const limit = 10;
  const [rows, total] = await Promise.all([listAuditLogs({ limit, offset: page * limit }), countAuditLogs()]);

  const lines = ['📜 <b>Audit log</b>', '', `${total} entries.`, ''];
  for (const row of rows) {
    const icon = row.result === 'SUCCESS' ? '✅' : row.result === 'FAILURE' ? '❌' : row.result === 'DENIED' ? '⛔️' : '⚠️';
    lines.push(`${icon} <b>${row.action}</b> · ${formatDateTime(row.created_at)}`, `   ${row.target_ref ? `<code>${row.target_ref}</code> · ` : ''}${row.actor_type}${row.reason ? ` · ${row.reason.slice(0, 60)}` : ''}`);
  }

  await ctx.editMessageText(lines.join('\n'), { parse_mode: 'HTML', reply_markup: auditKeyboard(page, page * limit + limit < total) });
}

// -----------------------------------------------------------------------------
// Broadcast
// -----------------------------------------------------------------------------

export async function handleBroadcastStart(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  ctx.session.step = { type: 'admin_broadcast' };
  await ctx.editMessageText(
    ['📣 <b>Broadcast</b>', '', 'Send the message that should go to every active user.', '', 'Type /cancel to abort.'].join('\n'),
    { parse_mode: 'HTML', reply_markup: withBack(new InlineKeyboard().text('❌ Cancel', 'a:home')) },
  );
}

export async function handleBroadcastSend(ctx: BotContext, text: string): Promise<void> {
  ctx.session.step = undefined;
  const users = await many<{ id: string; telegram_id: number }>(
    "SELECT id, telegram_id FROM users WHERE status = 'ACTIVE' AND telegram_id IS NOT NULL AND deleted_at IS NULL",
  );

  let queued = 0;
  for (const user of users) {
    await enqueueNotification({
      userId: user.id,
      telegramId: user.telegram_id,
      kind: 'CUSTOM',
      payload: { text: `📣 ${text}` },
      dedupeKey: `broadcast:${Date.now()}:${user.id}`,
    });
    queued += 1;
  }

  await enqueueAdminNotification('ADMIN_ALERT', { title: 'Broadcast queued', message: `Queued for ${queued} active user(s).` }, `broadcast-done:${Date.now()}`);

  await ctx.reply(`📣 Broadcast queued for <b>${queued}</b> user(s). Delivery is handled by the notification worker.`, {
    parse_mode: 'HTML',
    reply_markup: new InlineKeyboard().text('🛠 Admin', 'a:home'),
  });
}



// -----------------------------------------------------------------------------
// Deposits & wallet funding (operator decision 2026-10-08)
// -----------------------------------------------------------------------------

/** 💳 Deposits queue: every pending request with per-row ✅/❌ buttons. */
export async function handleDeposits(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const pending = await listPendingDeposits(20);

  const lines: string[] = ['💳 <b>Deposit requests</b>', ''];
  if (pending.length === 0) {
    lines.push('No pending requests. ✅');
  } else {
    lines.push(`${pending.length} pending request${pending.length === 1 ? '' : 's'}:`);
    for (const r of pending) {
      const who = r.username ? `@${r.username}` : (r.display_name ?? String(r.telegram_id ?? '?'));
      lines.push('', `💵 <b>${formatUsd(r.amount_cents)}</b> · ${who}`);
      lines.push(`   💳 ${r.method_name ?? '—'} · TXID: <code>${(r.note ?? '—').slice(0, 80)}</code>`);
      lines.push(`   🕐 ${formatDateTime(r.requested_at)}`);
    }
  }

  await ctx.editMessageText(lines.join('\n'), {
    parse_mode: 'HTML',
    reply_markup: pending.length > 0 ? depositsQueueKeyboard(pending) : new InlineKeyboard().text('🛠 Admin Panel', 'a:home').text('⬅️ Back', 'nav:back'),
  });
}

/** ✅ Approve a deposit: credit happens in one atomic transaction (service side). */
export async function handleDepositApprove(ctx: BotContext, requestId: string): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  try {
    const result = await approveDepositRequest(requestId, {
      adminId: ctx.state.user?.id ?? 'system',
      adminTelegramId: ctx.from?.id ?? null,
      requestId: ctx.state.requestId,
    });
    const request = result.request;
    if (result.alreadyDone) {
      await ctx.editMessageText(`ℹ️ Deposit #${requestId.slice(0, 8)} was already decided (status: ${request.status}). No second credit happened.`, {
        reply_markup: new InlineKeyboard().text('💳 Deposits', 'a:deps').text('🛠 Admin', 'a:home'),
      });
      return;
    }
    await ctx.editMessageText(
      [`✅ <b>Deposit approved</b>`, '', `Amount: <b>${formatUsd(request.amount_cents)}</b>`, request.note ? `TXID: <code>${request.note.slice(0, 80)}</code>` : '', 'The user has been notified and the money is in their balance.'].filter(Boolean).join('\n'),
      { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('💳 Deposits', 'a:deps').text('🛠 Admin', 'a:home') },
    );
  } catch (err) {
    const appError = toAppError(err);
    await ctx.editMessageText(`❌ Could not approve: ${appError.userMessage}`, {
      reply_markup: new InlineKeyboard().text('💳 Deposits', 'a:deps').text('🛠 Admin', 'a:home'),
    });
  }
}

export async function handleDepositReject(ctx: BotContext, requestId: string): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  try {
    const result = await rejectDepositRequest(requestId, {
      adminId: ctx.state.user?.id ?? 'system',
      adminTelegramId: ctx.from?.id ?? null,
      requestId: ctx.state.requestId,
    });
    if (result.alreadyDone) {
      await ctx.editMessageText(`ℹ️ Deposit #${requestId.slice(0, 8)} was already decided.`, {
        reply_markup: new InlineKeyboard().text('💳 Deposits', 'a:deps').text('🛠 Admin', 'a:home'),
      });
      return;
    }
    await ctx.editMessageText('❌ Deposit rejected - the user has been notified.', {
      reply_markup: new InlineKeyboard().text('💳 Deposits', 'a:deps').text('🛠 Admin', 'a:home'),
    });
  } catch (err) {
    const appError = toAppError(err);
    await ctx.editMessageText(`❌ Could not reject: ${appError.userMessage}`, {
      reply_markup: new InlineKeyboard().text('💳 Deposits', 'a:deps').text('🛠 Admin', 'a:home'),
    });
  }
}

/** 💳 Add Balance on a user card → ask for the amount as a chat message. */
export async function handleFundStart(ctx: BotContext, userId: string): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const user = await getUserById(userId);
  if (!user) {
    await ctx.editMessageText('❌ User not found.', { reply_markup: backToMenuKeyboard(true) });
    return;
  }
  ctx.session.step = { type: 'admin_fund_amount', targetUserId: userId };
  await ctx.editMessageText(
    [
      '💳 <b>Add balance</b>',
      '',
      `User: ${user.username ? `@${user.username}` : (user.display_name ?? user.telegram_id)}`,
      '',
      'Type the amount in USD to add to their wallet (e.g. <code>5</code> or <code>$10.50</code>).',
      'The money is credited instantly and the user is notified.',
    ].join('\n'),
    { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('❌ Cancel', 'm:cancel').text('⬅️ Back', 'nav:back') },
  );
}

export async function handleFundAmountInput(ctx: BotContext, text: string): Promise<void> {
  const step = ctx.session.step;
  if (step?.type !== 'admin_fund_amount') return;
  ctx.session.step = undefined;

  const { parseDepositAmountCents } = await import('../../services/deposit.service.js');
  const cents = parseDepositAmountCents(text);
  if (cents === null || cents <= 0 || cents > 10_000_000) {
    await ctx.reply('❌ Invalid amount. Use the 💳 Add Balance button again and type e.g. <code>5</code> or <code>$10.50</code>, or /cancel.', {
      parse_mode: 'HTML',
    });
    ctx.session.step = step; // keep the step so the retry stays in context
    return;
  }
  try {
    const result = await adminFundWallet(step.targetUserId, cents, {
      adminId: ctx.state.user?.id ?? 'system',
      adminTelegramId: ctx.from?.id ?? null,
      reason: 'Manual top-up via bot',
      requestId: ctx.state.requestId,
    });
    await handleUserDetail(ctx, step.targetUserId);
    await ctx.reply(`✅ ${formatUsd(cents)} added - new balance: <b>${formatUsd(result.newBalanceCents)}</b>. The user has been notified.`, {
      parse_mode: 'HTML',
      reply_markup: backToMenuKeyboard(true),
    });
  } catch (err) {
    const appError = toAppError(err);
    await ctx.reply(`❌ Could not add balance: ${appError.userMessage}`, { reply_markup: backToMenuKeyboard(true) });
  }
}


// -----------------------------------------------------------------------------
// Payment methods (gateways) management (operator decision 2026-10-08)
// -----------------------------------------------------------------------------

export async function handlePaymentMethods(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const methods = await listAllPaymentMethods();
  const lines: string[] = ['💳 <b>Payment Methods</b>', ''];
  if (methods.length === 0) lines.push('No methods yet - add one below.');
  for (const m of methods) {
    lines.push(`${m.icon ?? '💠'} <b>${m.name}</b> ${m.status === 'ACTIVE' ? '🟢' : '⚫️'}`);
    lines.push(`   <code>${m.address.slice(0, 60)}${m.address.length > 60 ? '…' : ''}</code>`);
  }
  lines.push('', 'Users pick from the 🟢 ACTIVE methods in the Deposer flow.');
  await ctx.editMessageText(lines.join('\n'), { parse_mode: 'HTML', reply_markup: paymentMethodsKeyboard(methods) });
}

export async function handlePaymentMethodDetail(ctx: BotContext, methodId: string): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const m = await getPaymentMethod(methodId);
  if (!m) {
    await ctx.editMessageText('❌ Method not found.', { reply_markup: backToMenuKeyboard(true) });
    return;
  }
  await ctx.editMessageText(
    [
      `${m.icon ?? '💠'} <b>${m.name}</b> ${m.status === 'ACTIVE' ? '🟢' : '⚫️'}`,
      '',
      `Address/details:`,
      `<code>${m.address}</code>`,
      m.instructions ? `📝 ${m.instructions}` : '',
    ].filter(Boolean).join('\n'),
    { parse_mode: 'HTML', reply_markup: paymentMethodDetailKeyboard(m) },
  );
}

export async function handlePaymentMethodToggle(ctx: BotContext, methodId: string, status: 'ACTIVE' | 'DISABLED'): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  await setPaymentMethodStatus(methodId, status);
  await handlePaymentMethodDetail(ctx, methodId);
}

export async function handlePaymentMethodDelete(ctx: BotContext, methodId: string): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  try {
    await deletePaymentMethod(methodId);
    await handlePaymentMethods(ctx);
    await ctx.reply('🗑 Method deleted.', { reply_markup: backToMenuKeyboard(true) });
  } catch (err) {
    const appError = toAppError(err);
    await ctx.editMessageText(`❌ ${appError.userMessage}`, {
      reply_markup: new InlineKeyboard().text('⬅️ Method', `a:pm:${methodId}`).text('🛠 Admin', 'a:home'),
    });
  }
}

/** ➕ Add method → step 1: name. */
export async function handlePaymentMethodAddStart(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  ctx.session.step = { type: 'admin_pm_add_name' };
  await ctx.editMessageText(
    ['➕ <b>Add payment method</b>', '', 'Type the method name + optional icon, e.g. <code>💠 USDT (ERC-20)</code> or <code>bKash</code>.'].join('\n'),
    { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('❌ Cancel', 'm:cancel').text('⬅️ Back', 'nav:back') },
  );
}

export async function handlePaymentMethodAddName(ctx: BotContext, text: string): Promise<void> {
  const m = text.trim();
  const iconMatch = m.match(/^(\p{Extended_Pictographic}(?:\uFE0F)?)\s*/u);
  const name = (iconMatch ? m.slice(iconMatch[0].length) : m).trim();
  if (name.length < 2 || name.length > 60) {
    await ctx.reply('❌ Name must be 2–60 characters. Try again, or /cancel.');
    return;
  }
  ctx.session.step = { type: 'admin_pm_add_address', name: iconMatch ? `${iconMatch[0]} ${name}` : name };
  await ctx.reply(`Method: <b>${iconMatch ? `${iconMatch[0]} ${name}` : name}</b>\n\nNow send the <b>address / payment details</b> users must pay to (wallet address, Pay ID, bKash number…).`, { parse_mode: 'HTML' });
}

export async function handlePaymentMethodAddAddress(ctx: BotContext, text: string): Promise<void> {
  const step = ctx.session.step;
  if (step?.type !== 'admin_pm_add_address') return;
  ctx.session.step = undefined;
  const iconMatch = step.name.match(/^(\p{Extended_Pictographic}(?:\uFE0F)?)\s*/u);
  try {
    const created = await createPaymentMethod({
      name: iconMatch ? step.name.slice(iconMatch[0].length).trim() : step.name,
      icon: iconMatch ? iconMatch[0] : null,
      address: text.trim(),
    });
    await handlePaymentMethodDetail(ctx, created.id);
    await ctx.reply('✅ Method added and live - users can pick it in the deposit flow.', { reply_markup: backToMenuKeyboard(true) });
  } catch (err) {
    const appError = toAppError(err);
    await ctx.reply(`❌ ${appError.userMessage}`, { reply_markup: backToMenuKeyboard(true) });
  }
}

/** ✏️ Edit address → one text step. */
export async function handlePaymentMethodEditStart(ctx: BotContext, methodId: string): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const m = await getPaymentMethod(methodId);
  if (!m) return;
  ctx.session.step = { type: 'admin_pm_edit_address', methodId };
  await ctx.editMessageText(
    [`✏️ <b>Edit ${m.name}</b>`, '', 'Send the new <b>address / payment details</b> (wallet address, Pay ID, bKash number…).'].join('\n'),
    { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('❌ Cancel', 'm:cancel').text('⬅️ Back', 'nav:back') },
  );
}

export async function handlePaymentMethodEditAddress(ctx: BotContext, text: string): Promise<void> {
  const step = ctx.session.step;
  if (step?.type !== 'admin_pm_edit_address') return;
  ctx.session.step = undefined;
  try {
    await updatePaymentMethodAddress(step.methodId, text.trim());
    await handlePaymentMethodDetail(ctx, step.methodId);
    await ctx.reply('✅ Address updated.', { reply_markup: backToMenuKeyboard(true) });
  } catch (err) {
    const appError = toAppError(err);
    await ctx.reply(`❌ ${appError.userMessage}`, { reply_markup: backToMenuKeyboard(true) });
  }
}
