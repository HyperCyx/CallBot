-- 015 - wallets, balance ledger and manual deposit requests.
--
-- Product rules (operator decision, 2026-10-08):
--   * no plans in the bot UX; a country is either FREE or PAID (price shown on
--     the country picker line itself);
--   * paid numbers are charged from the user's USD wallet at assignment time -
--     debit lives inside the assignment transaction, so a failed assignment
--     can never take money;
--   * top-ups are manual: the user files a deposit request, an admin approves
--     (or rejects) it in the bot, or an admin funds the account directly;
--   * every balance movement is a ledger line - the balance column is a cache
--     of the ledger, never written outside a movement.

-- Wallet: one per user. The balance may never go below zero; the debit SQL
-- guards with a balance >= amount clause (row lock makes concurrent debits
-- safe).
CREATE TABLE IF NOT EXISTS wallets (
  user_id          uuid PRIMARY KEY REFERENCES users(id),
  balance_cents    bigint NOT NULL DEFAULT 0 CHECK (balance_cents >= 0),
  currency         char(3) NOT NULL DEFAULT 'USD',
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_wallets_updated_at ON wallets;
CREATE TRIGGER trg_wallets_updated_at BEFORE UPDATE ON wallets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Ledger: append-only. amount_cents is signed (negative = money out).
CREATE TABLE IF NOT EXISTS wallet_transactions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_user_id      uuid NOT NULL REFERENCES wallets(user_id),
  kind                text NOT NULL CHECK (kind IN ('DEPOSIT','PURCHASE','REFUND','ADMIN_ADJUSTMENT')),
  amount_cents        bigint NOT NULL,
  balance_after_cents bigint NOT NULL CHECK (balance_after_cents >= 0),
  currency            char(3) NOT NULL DEFAULT 'USD',
  reference           text,
  actor_type          text NOT NULL DEFAULT 'SYSTEM' CHECK (actor_type IN ('USER','ADMIN','SYSTEM')),
  actor_id            uuid,
  metadata            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wtx_wallet   ON wallet_transactions(wallet_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wtx_reference ON wallet_transactions(reference);

-- Manual deposit requests: user asks, admin decides. One PENDING at a time per
-- user so the admin queue and the DM dedupe stay trivial, and so an impatient
-- repeated tap cannot fork the audit trail.
CREATE TABLE IF NOT EXISTS deposit_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id),
  amount_cents  bigint NOT NULL CHECK (amount_cents >= 50),      -- min $0.50
  currency      char(3) NOT NULL DEFAULT 'USD',
  note          text,
  status        text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED','CANCELLED')),
  requested_at  timestamptz NOT NULL DEFAULT now(),
  decided_at    timestamptz,
  decided_by    uuid REFERENCES users(id),
  decision_note text,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_deposit_one_pending ON deposit_requests(user_id) WHERE status = 'PENDING';
CREATE INDEX IF NOT EXISTS idx_deposit_status ON deposit_requests(status, requested_at);

DROP TRIGGER IF EXISTS trg_deposit_updated_at ON deposit_requests;
CREATE TRIGGER trg_deposit_updated_at BEFORE UPDATE ON deposit_requests
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
