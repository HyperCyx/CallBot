import type pg from 'pg';
import { AppError, badInput } from '../lib/errors.js';
import type { DbClient } from '../db/pool.js';
import { many, one, query, withTransaction } from '../db/pool.js';

/**
 * Wallet / balance (operator decision 2026-10-08).
 *
 *   * one wallet per user, USD cents, never negative (CHECK constraint plus a
 *     guarded UPDATE that fails atomically on insufficient funds);
 *   * every movement appends a ledger row carrying balance_after, so the
 *     audit story of every cent is reconstructable from wallet_transactions
 *     alone and the wallet row is purely a lock target / cache;
 *   * all mutators accept an optional transaction client: the number
 *     assignment debits INSIDE its own transaction so a rolled-back
 *     assignment can never cost the user money.
 */

export type WalletCurrency = string; // char(3), default 'USD'

export interface WalletRow {
  user_id: string;
  balance_cents: number;
  currency: WalletCurrency;
}

export type WalletTxKind = 'DEPOSIT' | 'PURCHASE' | 'REFUND' | 'ADMIN_ADJUSTMENT';

export interface WalletTransactionRow {
  id: string;
  wallet_user_id: string;
  kind: WalletTxKind;
  amount_cents: number;
  balance_after_cents: number;
  currency: WalletCurrency;
  reference: string | null;
  actor_type: 'USER' | 'ADMIN' | 'SYSTEM';
  actor_id: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
}

export class InsufficientFundsError extends AppError {
  constructor(
    public readonly requiredCents: number,
    public readonly balanceCents: number,
  ) {
    super('INSUFFICIENT_FUNDS', 'Not enough balance for this purchase.', {
      details: { requiredCents, balanceCents },
    });
  }
}

/** id → wallet; creates the wallet row on first touch (lazy, one row ever). */
export async function getWallet(userId: string, client?: DbClient): Promise<WalletRow> {
  const q = <T extends pg.QueryResultRow>(sql: string, params: unknown[]): Promise<pg.QueryResult<T>> =>
    client ? client.query<T>(sql, params as never[]) : query<T>(sql, params as never[]);
  const res = await q<WalletRow>(
    `INSERT INTO wallets (user_id) VALUES ($1)
     ON CONFLICT (user_id) DO NOTHING
     RETURNING user_id, balance_cents, currency`,
    [userId],
  );
  if (res.rows[0]) return res.rows[0];
  // The fallback SELECT MUST go through q(): inside a caller's transaction the
  // row just inserted is only visible on that connection (found by the
  // adminFundWallet test which credited inside withTransaction).
  const existing = await q<WalletRow>('SELECT user_id, balance_cents, currency FROM wallets WHERE user_id = $1', [userId]);
  if (existing.rows[0]) return existing.rows[0];
  throw new Error(`wallet for user ${userId} could not be read nor created`);
}

export async function getBalanceCents(userId: string): Promise<number> {
  const wallet = await getWallet(userId);
  return wallet.balance_cents;
}

/** Cents like 450 → "$4.50"; negative amounts render as "-$4.50". */
export function formatUsd(cents: number, currency = 'USD'): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const dollars = `${(abs / 100).toFixed(2)}`;
  if (currency === 'USD') return `${sign}$${dollars}`;
  return `${sign}${dollars} ${currency}`;
}

function assertAmount(amountCents: number): void {
  if (!Number.isSafeInteger(amountCents) || amountCents === 0) throw badInput('Amount must be a non-zero cent amount.');
  if (Math.abs(amountCents) > 100_000_000) throw badInput('Amount is out of the supported range.');
}

interface MovementOpts {
  reference?: string | null;
  actorType?: 'USER' | 'ADMIN' | 'SYSTEM';
  actorId?: string | null;
  metadata?: Record<string, unknown>;
  client?: DbClient;
}

async function applyMovement(kind: WalletTxKind, userId: string, amountCents: number, opts: MovementOpts): Promise<WalletTransactionRow> {
  assertAmount(amountCents);
  const run = async (client: DbClient): Promise<WalletTransactionRow> => {
    await getWallet(userId, client);
    // Atomic guarded update: the balance >= amount clause only binds for
    // debits (negative amounts); the row lock serialises concurrent debits
    // so two parallel purchases can never both see "enough".
    const updated = await client.query<{ balance_cents: number }>(
      `UPDATE wallets
          SET balance_cents = balance_cents + $2
        WHERE user_id = $1
          AND ($2 >= 0 OR balance_cents >= -$2)
        RETURNING balance_cents`,
      [userId, amountCents],
    );
    const row = updated.rows[0];
    if (!row) {
      const current = await one<{ balance_cents: number }>('SELECT balance_cents FROM wallets WHERE user_id = $1', [userId], );
      throw new InsufficientFundsError(-amountCents, current?.balance_cents ?? 0);
    }
    const ledger = await client.query<WalletTransactionRow>(
      `INSERT INTO wallet_transactions (wallet_user_id, kind, amount_cents, balance_after_cents, reference, actor_type, actor_id, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
       RETURNING *`,
      [
        userId,
        kind,
        amountCents,
        row.balance_cents,
        opts.reference ?? null,
        opts.actorType ?? 'SYSTEM',
        opts.actorId ?? null,
        JSON.stringify(opts.metadata ?? {}),
      ],
    );
    return ledger.rows[0]!;
  };

  if (opts.client) return run(opts.client);
  return withTransaction((client) => run(client));
}

export async function creditWallet(userId: string, amountCents: number, opts: MovementOpts = {}): Promise<WalletTransactionRow> {
  if (amountCents <= 0) throw badInput('Credit amount must be positive.');
  return applyMovement('DEPOSIT', userId, amountCents, opts);
}

export async function adjustWallet(userId: string, amountCents: number, opts: MovementOpts = {}): Promise<WalletTransactionRow> {
  return applyMovement('ADMIN_ADJUSTMENT', userId, amountCents, opts);
}

/** DEBITS: throws InsufficientFundsError when the wallet cannot cover it. */
export async function debitWallet(userId: string, amountCents: number, opts: MovementOpts = {}): Promise<WalletTransactionRow> {
  if (amountCents <= 0) throw badInput('Debit amount must be positive.');
  return applyMovement('PURCHASE', userId, -amountCents, opts);
}

export async function refundWallet(userId: string, amountCents: number, opts: MovementOpts = {}): Promise<WalletTransactionRow> {
  if (amountCents <= 0) throw badInput('Refund amount must be positive.');
  return applyMovement('REFUND', userId, amountCents, opts);
}

export async function listWalletTransactions(userId: string, limit = 10): Promise<WalletTransactionRow[]> {
  return many<WalletTransactionRow>(
    `SELECT * FROM wallet_transactions WHERE wallet_user_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2`,
    [userId, Math.max(1, Math.min(50, limit))],
  );
}
