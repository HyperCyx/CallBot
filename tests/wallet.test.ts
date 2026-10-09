import { describe, expect, it } from 'vitest';
import { one, query } from '../src/db/pool.js';
import { assignNumber } from '../src/services/assignment.service.js';
import { addNumbersToInventory, createSipAccount, createUser, getCountryId, getNumberRow, getServiceId, mockPbx } from './helpers.js';
import { auditActions } from './helpers.js';
import {
  InsufficientFundsError,
  creditWallet,
  debitWallet,
  formatUsd,
  getBalanceCents,
  getWallet,
  listWalletTransactions,
} from '../src/services/wallet.service.js';
import { createPaymentMethod } from '../src/services/payment-method.service.js';
import {
  DEPOSIT_MIN_CENTS,
  adminFundWallet,
  approveDepositRequest,
  cancelDepositRequest,
  createDepositRequest,
  getDepositRequest,
  listPendingDeposits,
  parseDepositAmountCents,
  pendingDepositForUser,
  rejectDepositRequest,
} from '../src/services/deposit.service.js';

/**
 * Wallet & deposit system (operator decision 2026-10-08).
 *
 * The contract under test is atomicity and idempotence, exactly as the
 * operator demanded:
 *   * a paid assignment charges the wallet INSIDE the reservation transaction —
 *     insufficient balance means nothing is reserved and nothing is deducted;
 *   * any failure after the charge (PBX route step) refunds it, atomically;
 *   * a deposit is credited exactly once even if ✅ is tapped (or raced) twice;
 *   * one pending deposit per user, enforced by a database constraint.
 */

async function activeUser() {
  const user = await createUser();
  await createSipAccount(user.id);
  return user;
}

/** Make the default country/service offer paid at `cents`. */
async function makePaidOffer(cents: number, countryId?: string, serviceId?: string) {
  const sid = serviceId ?? (await getServiceId());
  const cid = countryId ?? (await getCountryId());
  await query(
    `INSERT INTO service_countries (service_id, country_id, price_cents, currency)
     VALUES ($1,$2,$3,'USD')
     ON CONFLICT (service_id, country_id) DO UPDATE SET price_cents = $3, currency = 'USD', status = 'ACTIVE'`,
    [sid, cid, cents],
  );
}

describe('wallet: balance, debits and credits', () => {
  it('creates the wallet lazily with a zero balance', async () => {
    const user = await activeUser();
    const wallet = await getWallet(user.id);
    expect(wallet.balance_cents).toBe(0);
    expect(await getBalanceCents(user.id)).toBe(0);
    // Only one row ever exists per user.
    const rows = await one<{ c: string }>('SELECT count(*)::text AS c FROM wallets WHERE user_id = $1', [user.id]);
    expect(rows!.c).toBe('1');
  });

  it('credits and debits, tracking the running balance on each ledger line', async () => {
    const user = await activeUser();
    await creditWallet(user.id, 500, { reference: 'test:credit' });
    const tx = await debitWallet(user.id, 199, { reference: 'test:debit' });
    expect(tx.kind).toBe('PURCHASE');
    expect(tx.amount_cents).toBe(-199);
    expect(tx.balance_after_cents).toBe(301);
    expect(await getBalanceCents(user.id)).toBe(301);

    const txs = await listWalletTransactions(user.id);
    expect(txs).toHaveLength(2);
    expect(formatUsd(301)).toBe('$3.01');
  });

  it('a missing balance rejects the debit and moves nothing', async () => {
    const user = await activeUser();
    await creditWallet(user.id, 100, { reference: 'test:credit' });
    const err = await debitWallet(user.id, 500, { reference: 'test:deny' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InsufficientFundsError);
    expect((err as InsufficientFundsError).details?.requiredCents).toBe(500);
    expect((err as InsufficientFundsError).details?.balanceCents).toBe(100);
    expect(await getBalanceCents(user.id)).toBe(100);
    expect(await listWalletTransactions(user.id)).toHaveLength(1); // only the credit
  });

  it('the atomic guard stays correct across interleaved movements', async () => {
    const user = await activeUser();
    await creditWallet(user.id, 300, { reference: 'seed' });
    const results = await Promise.allSettled([
      debitWallet(user.id, 250, { reference: 'a' }),
      debitWallet(user.id, 250, { reference: 'b' }),
      debitWallet(user.id, 250, { reference: 'c' }),
    ]);
    const succeeded = results.filter((r) => r.status === 'fulfilled');
    expect(succeeded.length).toBe(1); // 300 across 3x250 -> exactly one winner
    const balance = await getBalanceCents(user.id);
    expect(balance).toBe(50);
    const manual = await one<{ bal: string }>(
      'SELECT COALESCE(sum(amount_cents),0)::bigint AS bal FROM wallet_transactions WHERE wallet_user_id = $1',
      [(await getWallet(user.id)).user_id],
    );
    expect(Number(manual!.bal)).toBe(balance); // ledger always sums to the balance
  });
});

describe('wallet: paid assignments are atomic (spec-level contract)', () => {
  it('a paid number charges the wallet and reports it on the result', async () => {
    const user = await activeUser();
    await creditWallet(user.id, 1000, { reference: 'topup' });
    await makePaidOffer(199);
    await addNumbersToInventory({ count: 1 });

    const result = await assignNumber({ userId: user.id, countryId: await getCountryId(), serviceId: await getServiceId() });
    expect(result.chargedCents).toBe(199);
    expect(result.balanceAfterCents).toBe(801);
    expect(await getBalanceCents(user.id)).toBe(801);
    const txs = await listWalletTransactions(user.id);
    expect(txs.some((t) => t.kind === 'PURCHASE' && t.amount_cents === -199)).toBe(true);
  });

  it('insufficient balance: nothing reserved, nothing deducted, INSUFFICIENT_FUNDS', async () => {
    const user = await activeUser();
    await creditWallet(user.id, 100, { reference: 'topup' });
    await makePaidOffer(199);
    const [numberId] = await addNumbersToInventory({ count: 1 }) as [string];

    const err = await assignNumber({ userId: user.id, countryId: await getCountryId(), serviceId: await getServiceId() }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InsufficientFundsError);

    // Inventory untouched: still AVAILABLE, no reservation, no assignment.
    const numberRow = await getNumberRow(numberId);
    expect(numberRow?.status).toBe('AVAILABLE');
    expect(numberRow?.assigned_user_id).toBeNull();
    const assignments = await query('SELECT count(*)::int AS c FROM number_assignments WHERE user_id = $1', [user.id]);
    expect(assignments.rows[0]!.c).toBe(0);
    // Wallet untouched: still 100, no PURCHASE row.
    expect(await getBalanceCents(user.id)).toBe(100);
    expect((await listWalletTransactions(user.id)).filter((t) => t.kind === 'PURCHASE')).toHaveLength(0);
  });

  it('a PBX failure after the charge refunds every cent', async () => {
    const user = await activeUser();
    await creditWallet(user.id, 500, { reference: 'topup' });
    await makePaidOffer(199);
    await addNumbersToInventory({ count: 1 });

    mockPbx().failNextOperation('addInboundRoute', 1, 'trunk unreachable', 'NETWORK');
    const err = await assignNumber({ userId: user.id, countryId: await getCountryId(), serviceId: await getServiceId() }).catch((e: unknown) => e);
    expect(err).toBeTruthy();

    expect(await getBalanceCents(user.id)).toBe(500); // fully refunded
    const txs = await listWalletTransactions(user.id);
    expect(txs.some((t) => t.kind === 'PURCHASE' && t.amount_cents === -199)).toBe(true);
    expect(txs.some((t) => t.kind === 'REFUND' && t.amount_cents === 199)).toBe(true);
  });

  it('free countries never touch the wallet', async () => {
    const user = await activeUser();
    await addNumbersToInventory({ count: 1 }); // no paid offer row
    const result = await assignNumber({ userId: user.id, countryId: await getCountryId(), serviceId: await getServiceId() });
    expect(result.chargedCents ?? 0).toBe(0);
    expect((await listWalletTransactions(user.id)).filter((t) => t.kind === 'PURCHASE')).toHaveLength(0);
  });
});

describe('deposits: manual approval lifecycle with hard idempotence', () => {
  // The operator-added method picker before the amount step: every request
  // carries the gateway (Binance Pay / USDT / …) and the TXID the user typed.
  let methodSeq = 0;
  async function freshMethod() {
    methodSeq += 1;
    return (await createPaymentMethod({ name: `USDT Test ${methodSeq}`, address: `Tqwerty${methodSeq}abcdefghij` })).id;
  }
  const optsFor = (methodId: string, telegramId = 424242) => ({ amountCents: 500, methodId, txid: 'trx-abc-1234', telegramId, displayName: 'Wallet Tester' });

  it('amount parsing accepts normal USD spellings only', () => {
    expect(parseDepositAmountCents('5')).toBe(500);
    expect(parseDepositAmountCents('$10.50')).toBe(1050);
    expect(parseDepositAmountCents('10,50')).toBe(1050);
    expect(parseDepositAmountCents('0.50')).toBe(50); // exactly the floor
    expect(parseDepositAmountCents('0.01')).toBeNull(); // below the $0.50 floor
    expect(parseDepositAmountCents('-5')).toBeNull();
    expect(parseDepositAmountCents('banana')).toBeNull();
    expect(parseDepositAmountCents('')).toBeNull();
    expect(DEPOSIT_MIN_CENTS).toBe(50);
  });

  it('approving twice credits exactly once', async () => {
    const methodId = await freshMethod();
    const user = await activeUser();
    const request = await createDepositRequest(user.id, optsFor(methodId));

    const first = await approveDepositRequest(request.id, { adminId: user.id });
    expect(first.alreadyDone).toBe(false);
    expect(first.newBalanceCents).toBe(500);

    const second = await approveDepositRequest(request.id, { adminId: user.id });
    expect(second.alreadyDone).toBe(true);

    expect(await getBalanceCents(user.id)).toBe(500); // not 1000
    const txs = await listWalletTransactions(user.id);
    expect(txs.filter((t) => t.kind === 'DEPOSIT')).toHaveLength(1);
  });

  it('one pending request per user, enforced at the database level', async () => {
    const methodId = await freshMethod();
    const user = await activeUser();
    await createDepositRequest(user.id, optsFor(methodId));
    await expect(createDepositRequest(user.id, optsFor(methodId, 999999))).rejects.toThrow(/pending/i);

    // A direct second INSERT must hit the partial unique index.
    await expect(
      query("INSERT INTO deposit_requests (user_id, amount_cents) VALUES ($1, 700)", [user.id]),
    ).rejects.toThrow();
  });

  it('rejecting after approving (or approving after rejecting) is a no-op', async () => {
    const methodId = await freshMethod();
    const user = await activeUser();
    const request = await createDepositRequest(user.id, optsFor(methodId));
    const approved = await approveDepositRequest(request.id, { adminId: user.id });
    expect(approved.alreadyDone).toBe(false);
    const rejected = await rejectDepositRequest(request.id, { adminId: user.id });
    expect(rejected.alreadyDone).toBe(true);
    expect((await getDepositRequest(request.id)).status).toBe('APPROVED');
    expect(await getBalanceCents(user.id)).toBe(500);
  });

  it('cancellation frees the user to open a new request', async () => {
    const methodId = await freshMethod();
    const user = await activeUser();
    await createDepositRequest(user.id, optsFor(methodId));
    expect(await pendingDepositForUser(user.id)).not.toBeNull();
    expect(await cancelDepositRequest(user.id)).toBe(true);
    expect(await pendingDepositForUser(user.id)).toBeNull();
    const again = await createDepositRequest(user.id, optsFor(methodId, 777));
    expect(again.status).toBe('PENDING');
  });

  it('the pending queue lists requests with method and user identity attached', async () => {
    const methodId = await freshMethod();
    const user = await activeUser();
    await createDepositRequest(user.id, optsFor(methodId));
    const queue = await listPendingDeposits();
    expect(queue.length).toBe(1);
    expect(queue[0]!.user_id).toBe(user.id);
    expect(queue[0]!.amount_cents).toBe(500);
    expect(queue[0]!.method_name).toContain('USDT Test');
    expect(queue[0]!.note).toBe('trx-abc-1234');
  });

  it('a method that has been disabled can no longer accept new requests', async () => {
    const { setPaymentMethodStatus } = await import('../src/services/payment-method.service.js');
    const methodId = await freshMethod();
    await setPaymentMethodStatus(methodId, 'DISABLED');
    const user = await activeUser();
    await expect(createDepositRequest(user.id, optsFor(methodId))).rejects.toThrow();
    expect(await pendingDepositForUser(user.id)).toBeNull();
  });
});

describe('admin: direct wallet funding', () => {
  it('adds balance instantly with an audit trail', async () => {
    const admin = await createUser({ telegramId: 3000001, username: 'admin1' });
    const user = await activeUser();
    const result = await adminFundWallet(user.id, 1234, { adminId: admin.id, reason: 'support top-up' });
    expect(result.newBalanceCents).toBe(1234);
    expect(await getBalanceCents(user.id)).toBe(1234);
    const txs = await listWalletTransactions(user.id);
    expect(txs[0]!.kind).toBe('ADMIN_ADJUSTMENT');
    expect(await auditActions()).toContain('WALLET_ADJUSTED');
  });

  it('never lets an adjustment drag a balance below zero', async () => {
    const admin = await createUser({ telegramId: 3000002, username: 'admin2' });
    const user = await activeUser();
    await expect(adminFundWallet(user.id, -100, { adminId: admin.id, reason: 'clawback' })).rejects.toThrow();
    expect(await getBalanceCents(user.id)).toBe(0);
  });
});
