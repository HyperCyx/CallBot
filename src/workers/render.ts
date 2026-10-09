import type { NotificationRow } from '../services/notification.service.js';
import { formatDateTime, formatDuration } from '../lib/time.js';
import { maskNumber } from '../lib/logger.js';

/**
 * Renders queued notifications into Telegram messages.
 *
 * Kept separate from the bot so the worker can be deployed without the bot's
 * handler graph, and so message wording has exactly one home.
 */

export interface NotificationButton {
  text: string;
  callbackData: string;
}

/** Buttons rendered under the notification (e.g. Approve / Reject). */
export type NotificationSender = (
  chatId: number | string,
  text: string,
  opts?: { buttons?: NotificationButton[][] },
) => Promise<unknown>;

const esc = (v: unknown): string =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

export function renderNotification(notification: NotificationRow): string | null {
  const p = notification.payload as Record<string, unknown>;
  const str = (key: string, fallback = '—') => {
    const v = p[key];
    return v === null || v === undefined || v === '' ? fallback : String(v);
  };

  switch (notification.kind) {
    case 'USER_APPROVED':
      return [
        '🎉 <b>Your account has been approved</b>',
        '',
        `🔑 SIP ID: <code>${str('extension')}</code>`,
        'ℹ️ Open <b>SIP Information</b> in the main menu to view your password.',
        '',
        'Tap /menu to get started.',
      ].join('\n');

    case 'USER_REJECTED':
      return ['🚫 <b>Your registration was not approved</b>', '', p['reason'] ? `Reason: ${str('reason')}` : 'Please contact support if you think this is a mistake.'].join('\n');

    case 'USER_BLOCKED':
      return ['⛔️ <b>Your account has been blocked</b>', '', p['reason'] ? `Reason: ${str('reason')}` : 'Please contact support for details.'].join('\n');

    case 'USER_UNBLOCKED':
      return '✅ <b>Your account has been reactivated.</b> Tap /menu to continue.';

    case 'NUMBER_ASSIGNED':
      return [
        '☎️ <b>Number assigned</b>',
        '',
        `📞 ${str('phoneNumber')}`,
        `🌍 ${str('country')}`,
        `📱 ${str('service')}`,
        `🔑 SIP ID: <code>${str('extension')}</code>`,
        '',
        'Incoming calls to this number now ring your SIP account.',
      ].join('\n');

    case 'NUMBER_RELEASED':
      return [
        '♻️ <b>Number released</b>',
        '',
        `📞 ${str('phoneNumber')}`,
        '',
        p['note'] ? str('note') : 'It has been returned to inventory and its inbound route was removed.',
      ].join('\n');

    case 'NUMBER_SUSPENDED':
      return `⚠️ <b>Number suspended</b>\n\n📞 ${str('phoneNumber')}\n\nIts inbound route has been disabled. Contact support for details.`;

    case 'NUMBER_UNSUSPENDED':
      return `✅ <b>Number reactivated</b>\n\n📞 ${str('phoneNumber')}\n\nThe number is reachable again.`;

    case 'EXPIRY_WARNING':
      return [
        `🔔 <b>Expiry reminder</b>`,
        '',
        `${str('subject', 'Your subscription')} expires ${str('when')} (${str('date')}).`,
        '',
        'Contact support to renew before it lapses.',
      ].join('\n');

    case 'EXPIRED':
      return [
        '⌛️ <b>Your subscription has expired</b>',
        '',
        `Expired on ${str('date')}.`,
        'New number assignments are blocked until you renew. Existing numbers may be suspended.',
      ].join('\n');

    case 'ADMIN_NEW_USER':
      return [
        '👤 <b>New user request</b>',
        '',
        `Telegram ID: <code>${str('telegramId')}</code>`,
        `Username: ${str('username')}`,
        `Name: ${str('displayName')}`,
        `Registered: ${str('registeredAt')}`,
        '',
        'Open 👥 Users → Pending to approve.',
      ].join('\n');

    case 'ADMIN_DEPOSIT_REQUEST': {
      const cents = Number(p['amountCents'] ?? 0);
      return [
        '💳 <b>Deposit request</b>',
        '',
        `User: ${esc(p['displayName'])} (<code>${esc(p['telegramId'])}</code>)`,
        `Amount: <b>$${(cents / 100).toFixed(2)}</b>`,
        p['methodName'] ? `Method: ${esc(p['methodName'])}` : '',
        `TXID: <code>${esc(p['txid'] ?? p['note'])}</code>`,
        `Filed: ${str('requestedAt')}`,
        '',
        'Verify the payment, then ✅ Approve to credit their wallet instantly.',
      ].filter(Boolean).join('\n');
    }

    case 'USER_DEPOSIT_APPROVED': {
      const cents = Number(p['amountCents'] ?? 0);
      const bal = Number(p['newBalanceCents'] ?? 0);
      return [
        '✅ <b>Deposit approved</b>',
        '',
        `$${(cents / 100).toFixed(2)} has been credited to your balance.`,
        `New balance: <b>$${(bal / 100).toFixed(2)}</b>`,
      ].join('\n');
    }

    case 'USER_DEPOSIT_REJECTED': {
      const cents = Number(p['amountCents'] ?? 0);
      return [
        '❌ <b>Deposit request rejected</b>',
        '',
        `Your request for $${(cents / 100).toFixed(2)} was not approved.`,
        p['note'] ? `Note: ${esc(p['note'])}` : '',
        'If you already paid, please contact support with your payment reference.',
      ].filter(Boolean).join('\n');
    }

    case 'WALLET_CREDITED': {
      const cents = Number(p['deltaCents'] ?? 0);
      const bal = Number(p['newBalanceCents'] ?? 0);
      const sign = cents >= 0 ? '+' : '-';
      return [
        cents >= 0 ? '💰 <b>Balance added</b>' : '💸 <b>Balance adjusted</b>',
        '',
        `${sign}$${(Math.abs(cents) / 100).toFixed(2)} ${cents >= 0 ? 'credited to' : 'deducted from'} your wallet by the administrator.`,
        `New balance: <b>$${(bal / 100).toFixed(2)}</b>`,
      ].join('\n');
    }

    case 'ADMIN_ALERT': {
      const title = str('title', 'Admin alert');
      const body = str('message', '');
      return [`⚠️ <b>${title}</b>`, '', body].join('\n');
    }

    case 'RECONCILIATION_ALERT': {
      const findings = Array.isArray(p['findings']) ? (p['findings'] as Array<Record<string, string>>) : [];
      return [
        '🚨 <b>Reconciliation found problems</b>',
        '',
        `Critical findings: <b>${str('critical', '0')}</b>`,
        '',
        ...findings.slice(0, 5).map((f) => `• <b>${f['type'] ?? 'issue'}</b>: ${(f['detail'] ?? '').slice(0, 160)}`),
        '',
        'Open 🩺 Health in the admin panel for details. No destructive fix was applied automatically.',
      ].join('\n');
    }

    case 'SUPPORT_REPLY':
      return ['💬 <b>Support</b>', '', str('message', '')].join('\n');

    case 'CUSTOM':
      return p['text'] ? String(p['text']) : null;

    default:
      return null;
  }
}

/** Small helper used by admin screens for "how long ago" rendering. */
export function describeDuration(seconds: number): string {
  return formatDuration(seconds);
}

export { formatDateTime };
