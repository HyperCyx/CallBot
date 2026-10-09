import { badInput, conflict, notFound } from '../lib/errors.js';
import { many, one, query } from '../db/pool.js';

/**
 * Deposit payment methods (gateways) — operator decides which ones exist
 * (Binance Pay, USDT, bKash…), the address is shown to users mid-deposit and
 * the method travels with the request to the admin's ✅/❌ screen.
 */

export interface PaymentMethodRow {
  id: string;
  slug: string;
  name: string;
  icon: string | null;
  address: string;
  instructions: string | null;
  status: 'ACTIVE' | 'DISABLED';
  sort_order: number;
  created_at: Date;
  updated_at: Date;
}

/** Methods a user may pick: ACTIVE, most natural order first. */
export async function listActivePaymentMethods(): Promise<PaymentMethodRow[]> {
  return many<PaymentMethodRow>(
    `SELECT * FROM payment_methods
      WHERE status = 'ACTIVE'
      ORDER BY sort_order ASC, name ASC`,
  );
}

export async function listAllPaymentMethods(): Promise<PaymentMethodRow[]> {
  return many<PaymentMethodRow>(`SELECT * FROM payment_methods ORDER BY sort_order ASC, name ASC`);
}

export async function getPaymentMethod(id: string): Promise<PaymentMethodRow | null> {
  return one<PaymentMethodRow>('SELECT * FROM payment_methods WHERE id = $1', [id]);
}

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  return slug || `method_${Date.now()}`;
}

export async function createPaymentMethod(opts: {
  name: string;
  icon?: string | null;
  address: string;
  instructions?: string | null;
  sortOrder?: number;
}): Promise<PaymentMethodRow> {
  const name = opts.name.trim();
  const address = opts.address.trim();
  if (name.length < 2 || name.length > 60) throw badInput('Method name must be 2–60 characters.');
  if (address.length < 4 || address.length > 500) throw badInput('Address/details must be 4–500 characters.');

  const slug = slugify(name);
  const exists = await one<{ id: string }>('SELECT id FROM payment_methods WHERE slug = $1', [slug]);
  if (exists) throw conflict(`A method named “${name}” already exists.`);

  const maxSort = await one<{ m: number }>('SELECT COALESCE(MAX(sort_order),0) AS m FROM payment_methods', []);
  const row = await one<PaymentMethodRow>(
    `INSERT INTO payment_methods (slug, name, icon, address, instructions, sort_order)
     VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING *`,
    [slug, name, opts.icon?.trim() || null, address, opts.instructions?.trim() || null, opts.sortOrder ?? maxSort!.m + 10],
  );
  return row!;
}

/** Admin edits the address/details in place (the value users must send to). */
export async function updatePaymentMethodAddress(methodId: string, address: string, instructions?: string | null): Promise<PaymentMethodRow> {
  const trimmed = address.trim();
  if (trimmed.length < 4 || trimmed.length > 500) throw badInput('Address/details must be 4–500 characters.');
  const row = await one<PaymentMethodRow>(
    `UPDATE payment_methods
        SET address = $2, instructions = COALESCE($3, instructions)
      WHERE id = $1
      RETURNING *`,
    [methodId, trimmed, instructions?.trim() || null],
  );
  if (!row) throw notFound('Payment method');
  return row;
}

export async function setPaymentMethodStatus(methodId: string, status: 'ACTIVE' | 'DISABLED'): Promise<PaymentMethodRow> {
  const row = await one<PaymentMethodRow>(
    'UPDATE payment_methods SET status = $2 WHERE id = $1 RETURNING *',
    [methodId, status],
  );
  if (!row) throw notFound('Payment method');
  return row;
}

/** Hard delete is safe: requests keep a plain FK reference (nullable on set null is NOT configured, so refuse while referenced). */
export async function deletePaymentMethod(methodId: string): Promise<void> {
  const used = await one<{ c: string }>('SELECT count(*)::text AS c FROM deposit_requests WHERE payment_method_id = $1', [methodId]);
  if (Number(used!.c) > 0) throw conflict('This method has deposit requests attached - disable it instead.');
  const res = await query('DELETE FROM payment_methods WHERE id = $1 RETURNING id', [methodId]);
  if (res.rows.length === 0) throw notFound('Payment method');
}
