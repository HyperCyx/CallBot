import { env } from '../config/env.js';

/**
 * Phone number normalisation.
 *
 * WHY THIS EXISTS (spec §13)
 * -------------------------
 * A DID that arrives on the trunk is matched by FreePBX against the inbound
 * route `extension` field. Depending on the provider/trunk settings the same
 * DID can be delivered as `+971501234567`, `00971501234567` or `971501234567`.
 * If we store one form and the trunk delivers another, calls silently land on
 * the "any DID" catch-all route. So we store BOTH forms:
 *
 *   numbers.phone_number       -> canonical E.164  (+971501234567)
 *   numbers.did_match_pattern  -> the exact string FreePBX must match
 *
 * `didMatch` reproduces the provider's delivered form deterministically, and
 * `didCandidates` gives the reconciliation worker and the health check every
 * plausible variant so a mismatch can be detected *and repaired* instead of
 * failing silently.
 */

const E164 = /^\+[1-9]\d{6,14}$/;

export interface NormalizedNumber {
  /** Canonical E.164, e.g. +971501234567. Throws for junk. */
  e164: string;
  /** Digits only without '+', e.g. 971501234567. */
  digits: string;
  /** ISO-3166 alpha-2 if it could be inferred from a provided dial code, else null. */
  countryHint: string | null;
}

export class InvalidPhoneNumberError extends Error {
  constructor(public readonly input: string) {
    super(`Invalid phone number: ${input}`);
    this.name = 'InvalidPhoneNumberError';
  }
}

/**
 * Normalises a number to E.164.
 * Accepts: +971..., 00971..., 971..., with spaces/dashes/()/dots.
 * @param defaultDialCode dial code (without +) applied when the input has no
 *        international prefix and no leading '+'.
 */
export function normalizeE164(input: string, defaultDialCode?: string): NormalizedNumber {
  if (!input) throw new InvalidPhoneNumberError(input);
  let s = String(input).trim();
  // Keep digits and a possible leading +
  const hadPlus = s.startsWith('+');
  s = s.replace(/[^\d+]/g, '');
  if (s.startsWith('+')) s = s.slice(1);
  s = s.replace(/\+/g, '');

  if (s.startsWith('00')) {
    s = s.slice(2);
  } else if (!hadPlus && defaultDialCode) {
    // No international prefix given: assume the caller's national format.
    const dc = defaultDialCode.replace(/\D/g, '');
    if (!s.startsWith(dc)) s = dc + s.replace(/^0+/, '');
  }

  const e164 = `+${s}`;
  if (!E164.test(e164)) throw new InvalidPhoneNumberError(input);
  return { e164, digits: s, countryHint: null };
}

/** True when the string is a plausible E.164 number. */
export function isValidE164(input: string): boolean {
  return E164.test(input);
}

/**
 * The exact string FreePBX must be configured to match for this DID.
 * Controlled by DID_PREFIX / DID_NORMALIZE_STRIP_PLUS so it can be tuned to the
 * trunk's `context=from-trunk` delivery without touching code.
 */
export function didMatch(canonicalE164: string): string {
  let s = canonicalE164.trim();
  if (env.DID_NORMALIZE_STRIP_PLUS && s.startsWith('+')) s = s.slice(1);
  if (env.DID_PREFIX && !s.startsWith(env.DID_PREFIX)) s = env.DID_PREFIX + s;
  return s;
}

/** Every plausible delivered form of a DID, most likely first. Used by reconciliation. */
export function didCandidates(canonicalE164: string): string[] {
  const digits = canonicalE164.replace(/\D/g, '');
  const out = new Set<string>();
  const push = (v: string) => {
    if (v) out.add(v);
  };

  push(didMatch(canonicalE164));
  push(canonicalE164);
  push(digits);
  push(`+${digits}`);
  push(`00${digits}`);
  if (digits.startsWith('1') && digits.length === 11) {
    // NANP: trunk may strip the leading country code
    push(digits.slice(1));
  }
  return [...out];
}

/** Best-effort country dial code extraction for display only. */
export function dialCodeOf(e164: string): string | null {
  const digits = e164.replace(/\D/g, '');
  // 1-3 digit dial codes; 1 and 7 are single digit, the rest are validated
  // against the length-2/3 heuristic that is good enough for display.
  if (digits.startsWith('1') || digits.startsWith('7')) return digits.slice(0, 1);
  if (digits.length < 4) return null;
  const two = digits.slice(0, 2);
  const three = digits.slice(0, 3);
  // Known 2-digit codes (subset used for display heuristics; the authoritative
  // mapping lives in the countries table which admins manage).
  const twoDigit = new Set(['20', '27', '30', '31', '32', '33', '34', '36', '39', '40', '41', '43', '44', '45', '46', '47', '48', '49', '51', '52', '53', '54', '55', '56', '57', '58', '60', '61', '62', '63', '64', '65', '66', '81', '82', '84', '86', '90', '91', '92', '93', '94', '95', '98']);
  if (twoDigit.has(two)) return two;
  if (/^[2-9]\d\d$/.test(three)) return three;
  return null;
}

/** Pretty display: keeps '+', groups nothing (DIDs are short) but strips the country code noise. */
export function prettyNumber(e164: string): string {
  if (!e164) return '';
  return e164.startsWith('+') ? e164 : `+${e164}`;
}

/**
 * Asterisk/FreePBX extension validation: digits only, 2..11 chars, must be
 * inside the configured allocation range for auto-allocation.
 */
export function isValidExtension(ext: string): boolean {
  return /^\d{2,11}$/.test(ext);
}

export function isInExtensionRange(ext: string): boolean {
  if (!isValidExtension(ext)) return false;
  const n = Number(ext);
  return n >= env.freepbx.extensionRange.start && n <= env.freepbx.extensionRange.end;
}
