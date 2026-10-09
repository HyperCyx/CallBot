/**
 * Shared telegram sender for notification delivery, used by BOTH the bot
 * process and the standalone worker. History: the worker used to ignore the
 * buttons argument (live bug 2026-10-09: approval requests arrived without
 * ✅ Approve / ❌ Reject), so the two senders must never drift apart again.
 */
import { InlineKeyboard } from 'grammy';
import type { NotificationSender } from './render.js';

type RawSendMessage = (
  chatId: number | string,
  text: string,
  opts?: Record<string, unknown>,
) => Promise<unknown>;

export function createTelegramSender(sendMessage: RawSendMessage): NotificationSender {
  return async (chatId, text, opts) => {
    let replyMarkup: Record<string, unknown> | undefined;
    if (opts?.buttons?.length) {
      const kb = new InlineKeyboard();
      opts.buttons.forEach((row, idx) => {
        for (const b of row) kb.text(b.text, b.callbackData);
        if (idx < opts.buttons!.length - 1) kb.row(); // row() BETWEEN rows: no trailing empty row
      });
      replyMarkup = { reply_markup: kb };
    }
    await sendMessage(chatId, text, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...replyMarkup,
    });
  };
}
