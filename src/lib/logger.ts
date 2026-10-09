import pino from 'pino';
import { env } from '../config/env.js';

/**
 * Structured logging with hard redaction of secrets.
 *
 * Requirement (spec §27): "Never log SIP passwords, OAuth secrets, access tokens,
 * refresh tokens, database passwords."
 *
 * Redaction happens at the logger level (not at call sites) so a careless
 * `logger.info({ ctx })` can never leak a credential.
 */
const REDACT_PATHS = [
  'password',
  'passwd',
  'secret',
  'client_secret',
  'clientSecret',
  'token',
  'access_token',
  'accessToken',
  'refresh_token',
  'refreshToken',
  'authorization',
  'apiKey',
  'api_key',
  'sipPassword',
  'sip_password',
  'extPassword',
  'umPassword',
  'vmPassword',
  'encrypted',
  'dek',
  'kek',
  'databaseUrl',
  'DATABASE_URL',
  '*.password',
  '*.extPassword',
  '*.sip_password',
  '*.*.password',
  '*.*.extPassword',
  '*.*.secret',
  '*.secret',
  '*.token',
  '*.access_token',
  '*.refresh_token',
  '*.sipPassword',
  'req.headers.authorization',
  'req.headers["x-api-key"]',
  'headers.authorization',
];

export const logger = pino({
  level: env.LOG_LEVEL,
  redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
  base: { service: 'sipbot', env: env.NODE_ENV },
  timestamp: pino.stdTimeFunctions.isoTime,
  ...(env.LOG_PRETTY
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname,service,env' },
        },
      }
    : {}),
});

export type Logger = typeof logger;

/**
 * Creates a child logger bound to a request id so every log line for one
 * Telegram update / HTTP request can be correlated (spec §38: request IDs).
 */
export function childLogger(bindings: Record<string, unknown>): Logger {
  return logger.child(bindings);
}

/** Masks a phone number/DID for logs and audit output: +971501234567 -> +9715****567 */
export function maskNumber(value: string | null | undefined): string {
  if (!value) return '';
  const s = String(value);
  if (s.length <= 6) return '****';
  return `${s.slice(0, Math.min(5, s.length - 3))}****${s.slice(-3)}`;
}

/** Masks an identifier (e.g. a Telegram id or extension) for user-facing logs. */
export function maskId(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (s.length <= 4) return '****';
  return `${s.slice(0, 2)}***${s.slice(-2)}`;
}
