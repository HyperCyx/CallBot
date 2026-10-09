/**
 * Typed application errors.
 *
 * Every failure that a user or admin can observe maps to one of these so the
 * Telegram layer can render a consistent message and the audit log can record a
 * machine-readable reason code (spec §36 "Failure handling").
 */

import { ZodError } from 'zod';

export type ErrorCode =
  | 'BAD_INPUT'
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'UNAUTHORIZED'
  | 'RATE_LIMITED'
  | 'CONFLICT'
  | 'INSUFFICIENT_FUNDS'
  | 'NO_INVENTORY'
  | 'PLAN_LIMIT'
  | 'ACCOUNT_NOT_ACTIVE'
  | 'NUMBER_NOT_AVAILABLE'
  | 'PBX_UNAVAILABLE'
  | 'PBX_REJECTED'
  | 'RECONCILE_REQUIRED'
  | 'USERBOT_UNAVAILABLE'
  | 'INTERNAL';

export class AppError extends Error {
  public readonly code: ErrorCode;
  public readonly httpStatus: number;
  /** Safe to show to the end user (no internal detail, no secrets). */
  public readonly userMessage: string;
  public readonly details?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    userMessage: string,
    opts: { httpStatus?: number; details?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(`${code}: ${userMessage}`, { cause: opts.cause });
    this.name = 'AppError';
    this.code = code;
    this.userMessage = userMessage;
    this.httpStatus = opts.httpStatus ?? defaultStatus(code);
    this.details = opts.details;
  }

  toJSON() {
    return { code: this.code, message: this.userMessage, details: this.details };
  }
}

function defaultStatus(code: ErrorCode): number {
  switch (code) {
    case 'BAD_INPUT':
      return 400;
    case 'UNAUTHORIZED':
      return 401;
    case 'FORBIDDEN':
    case 'ACCOUNT_NOT_ACTIVE':
      return 403;
    case 'NOT_FOUND':
      return 404;
    case 'CONFLICT':
    case 'NUMBER_NOT_AVAILABLE':
    case 'PLAN_LIMIT':
      return 409;
    case 'INSUFFICIENT_FUNDS':
      return 402;
    case 'NO_INVENTORY':
      return 404;
    case 'RATE_LIMITED':
      return 429;
    case 'PBX_UNAVAILABLE':
    case 'RECONCILE_REQUIRED':
      return 502;
    case 'PBX_REJECTED':
      return 502;
    default:
      return 500;
  }
}

export const badInput = (msg: string, details?: Record<string, unknown>) => new AppError('BAD_INPUT', msg, { details });
export const notFound = (what = 'Resource') => new AppError('NOT_FOUND', `${what} not found`);
export const forbidden = (msg = 'You are not allowed to do that') => new AppError('FORBIDDEN', msg);
export const conflict = (msg: string) => new AppError('CONFLICT', msg);
export const rateLimited = (msg = 'Too many requests. Please slow down.') => new AppError('RATE_LIMITED', msg);

/**
 * Wraps an unknown thrown value into an AppError without leaking internals.
 *
 * Client faults (schema validation, malformed JSON bodies) are mapped to
 * BAD_INPUT so callers get an actionable 400 instead of a 500 - a wrong UUID in
 * a path is not an incident.
 */
export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;

  if (err instanceof ZodError) {
    return new AppError('BAD_INPUT', 'The request contained invalid or missing fields.', {
      details: {
        issues: err.issues.slice(0, 20).map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      },
    });
  }

  // express.json() raises a SyntaxError flagged with type 'entity.parse.failed'.
  if (typeof err === 'object' && err !== null && (err as { type?: string }).type === 'entity.parse.failed') {
    return new AppError('BAD_INPUT', 'The request body is not valid JSON.');
  }

  const msg = err instanceof Error ? err.message : String(err);
  return new AppError('INTERNAL', 'Something went wrong. The incident was logged.', { details: { internal: msg } });
}
