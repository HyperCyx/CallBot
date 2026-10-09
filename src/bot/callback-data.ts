/**
 * Inline keyboard callback-data guard.
 *
 * Telegram rejects a whole message with `BUTTON_DATA_INVALID` when any
 * `callback_data` exceeds **64 bytes**, and the failure is invisible from the
 * bot's side: the message is simply never delivered, so a screen that looks
 * fine in code renders as nothing at all in the chat. That is exactly how the
 * "Get my number" button (which carried a country, a service and a plan id -
 * 116 bytes) silently broke.
 *
 * Two defences live here:
 *
 *  1. `checkCallbackData` is called for every outgoing keyboard, so an
 *     oversized button is reported loudly in the logs instead of vanishing;
 *  2. the offending button is **removed** rather than sending the whole
 *     keyboard, so the rest of the screen still reaches the user.
 *
 * The rule is enforced, not assumed: multi-step flows keep their selections in
 * the session and use short callbacks (see `pendingOffer` in the session).
 */

/** Telegram's documented hard limit. */
export const MAX_CALLBACK_BYTES = 64;

export interface ButtonLike {
  text?: string;
  callback_data?: string;
  url?: string;
}

export interface CallbackViolation {
  text: string;
  data: string;
  bytes: number;
  reason: 'too-long' | 'not-ascii';
}

/** Returns the violations of a single button, or null when it is fine. */
export function checkCallbackData(button: ButtonLike): CallbackViolation | null {
  const data = button.callback_data;
  if (typeof data !== 'string' || data.length === 0) return null;
  const bytes = Buffer.byteLength(data, 'utf8');
  if (bytes > MAX_CALLBACK_BYTES) {
    return { text: button.text ?? '', data, bytes, reason: 'too-long' };
  }
  // Telegram also rejects non-ASCII payloads.
  if (!/^[\x20-\x7e]*$/.test(data)) {
    return { text: button.text ?? '', data, bytes, reason: 'not-ascii' };
  }
  return null;
}

export function inlineKeyboardRows(markup: unknown): ButtonLike[][] {
  if (!markup || typeof markup !== 'object') return [];
  const rows = (markup as { inline_keyboard?: unknown }).inline_keyboard;
  if (!Array.isArray(rows)) return [];
  return rows.filter(Array.isArray) as ButtonLike[][];
}

/**
 * Inspects one outgoing keyboard. Returns the violations found and a cleaned
 * keyboard with the invalid buttons dropped (never `undefined` when the input
 * was a valid inline keyboard).
 */
export function sanitizeInlineKeyboard(markup: unknown): {
  violations: CallbackViolation[];
  cleaned: Record<string, unknown> | undefined;
} {
  const rows = inlineKeyboardRows(markup);
  if (rows.length === 0) return { violations: [], cleaned: undefined };

  const violations: CallbackViolation[] = [];
  const cleanedRows: ButtonLike[][] = [];
  for (const row of rows) {
    const kept: ButtonLike[] = [];
    for (const button of row) {
      const violation = checkCallbackData(button);
      if (violation) violations.push(violation);
      else kept.push(button);
    }
    if (kept.length > 0) cleanedRows.push(kept);
  }

  return {
    violations,
    cleaned: violations.length > 0 ? { inline_keyboard: cleanedRows } : undefined,
  };
}
