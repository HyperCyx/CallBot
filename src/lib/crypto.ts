import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from 'node:crypto';
import { env } from '../config/env.js';

/**
 * Secrets at rest (spec §5, §18, §27)
 * =================================
 * SIP passwords and other credentials are never stored in plaintext.
 * Envelope-lite scheme:
 *
 *   plaintext --AES-256-GCM(KEK)-->  v1:<iv>:<tag>:<ciphertext>   (base64url parts)
 *
 * The KEK lives only in the process environment (SECRETS_KEK_BASE64) or an
 * external secrets manager, never in the database, never in logs, never in
 * Telegram messages.
 */

const VERSION = 'v1';
const ALGO = 'aes-256-gcm';

function loadKek(): Buffer {
  const raw = env.SECRETS_KEK_BASE64;
  if (!raw) {
    if (env.isProd) throw new Error('SECRETS_KEK_BASE64 is required in production');
    // Deterministic development key. Loudly refused in production by env.ts.
    return Buffer.alloc(32, 7);
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error(`SECRETS_KEK_BASE64 must decode to exactly 32 bytes (got ${key.length})`);
  }
  return key;
}

let cachedKek: Buffer | null = null;
function kek(): Buffer {
  if (!cachedKek) cachedKek = loadKek();
  return cachedKek;
}

/** Encrypts a secret for storage. Returns an opaque, versioned, self-describing string. */
export function encryptSecret(plaintext: string): string {
  if (plaintext === '') return '';
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, kek(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join(':');
}

/** Decrypts a stored secret. Throws if the ciphertext was tampered with or the key changed. */
export function decryptSecret(stored: string): string {
  if (!stored) return '';
  const parts = stored.split(':');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error('Malformed encrypted secret (expected v1:iv:tag:ct)');
  }
  const iv = Buffer.from(parts[1] as string, 'base64url');
  const tag = Buffer.from(parts[2] as string, 'base64url');
  const ct = Buffer.from(parts[3] as string, 'base64url');
  const decipher = createDecipheriv(ALGO, kek(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

/** True when a value looks like an output of encryptSecret(). */
export function isEncrypted(value: string): boolean {
  return typeof value === 'string' && value.startsWith(`${VERSION}:`) && value.split(':').length === 4;
}

/** HMAC-SHA256 hex digest, used for idempotency keys and signed callback data. */
export function hmac(input: string, key: string = env.SIGNING_KEY): string {
  return createHmac('sha256', key).update(input).digest('hex');
}

/** Constant-time string comparison for API keys / tokens. */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a ?? '', 'utf8');
  const bb = Buffer.from(b ?? '', 'utf8');
  if (ba.length !== bb.length) {
    // Still perform a comparison to keep the timing profile flat.
    timingSafeEqual(ba, ba);
    return false;
  }
  return timingSafeEqual(ba, bb);
}

/** Cryptographically strong random SIP password (Asterisk-safe alphabet). */
/**
 * SIP extension secrets are 12 digits - the operator's required format
 * (numeric-keypad friendly; applies to provisioning AND to user-rotated
 * passwords). randomInt gives uniform digits; ~40 bits of entropy per secret.
 */
/**
 * 12-character SIP password: letters + digits + symbols (operator decision
 * 2026-10-08, replacing the earlier digits-only format).
 *
 * Symbol set is deliberately SIP-safe: no whitespace, quotes, backslashes,
 * percent, ampersand, slash or equals — those break config files, phones with
 * picky parsers, and URL-encoded provisioning flows. Every generated password
 * is guaranteed to contain at least one lowercase letter, one uppercase
 * letter, one digit and one symbol, so a client-side "must mix" validator can
 * never reject it.
 */
export function generateSipPassword(length = 12): string {
  const lower = 'abcdefghijkmnpqrstuvwxyz'; // no l (lookalike)
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I, O (lookalikes)
  const digits = '23456789'; // no 0/1 (lookalikes)
  const symbols = '!@#$^*?+-.~';
  const all = lower + upper + digits + symbols;

  const required = [
    lower[randomInt(0, lower.length)]!,
    upper[randomInt(0, upper.length)]!,
    digits[randomInt(0, digits.length)]!,
    symbols[randomInt(0, symbols.length)]!,
  ];
  const pool: string[] = [];
  const target = Math.max(length, required.length);
  while (pool.length < target - required.length) pool.push(all[randomInt(0, all.length)]!);
  const chars = [...required, ...pool];
  // Fisher-Yates via randomInt so the guaranteed characters land anywhere.
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = randomInt(0, i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join('');
}

/** Human-friendly referral code: 8 chars, no ambiguous characters. */
export function generateReferralCode(length = 8): string {
  // Own alphabet, not the SIP one: referral codes stay alphanumeric.
  const alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < length; i += 1) out += alphabet[randomInt(0, alphabet.length)];
  return out.toUpperCase();
}

/** Numeric one-time code (for admin step-up confirmation of destructive actions). */
export function generateNumericCode(digits = 6): string {
  let out = '';
  for (let i = 0; i < digits; i += 1) out += String(randomInt(0, 10));
  return out;
}
