-- 016: Admin-managed deposit payment methods (gateways).
--
-- The operator asked for a method picker before the amount/txid steps:
-- Binance Pay, USDT (any network), anything else the admin configures from the
-- admin panel. A method carries the destination address/details that the bot
-- shows the user while the TXID is collected.

CREATE TABLE payment_methods (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- short code used internally (unique, stable across renames)
  slug         text NOT NULL UNIQUE,
  name         text NOT NULL,
  icon         text,
  -- what the user sends money to: wallet address, pay ID, bKash number…
  address      text NOT NULL,
  -- optional free-form guidance shown with the address
  instructions text,
  status       text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DISABLED')),
  sort_order   integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_payment_methods_updated_at ON payment_methods;
CREATE TRIGGER trg_payment_methods_updated_at
  BEFORE UPDATE ON payment_methods
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Every deposit request carries the method it was paid through (nullable so
-- requests filed before this release keep working).
ALTER TABLE deposit_requests
  ADD COLUMN payment_method_id uuid REFERENCES payment_methods(id);

CREATE INDEX idx_deposit_requests_method ON deposit_requests(payment_method_id);

-- Seed the two methods the operator named; they ship DISABLED so no user ever
-- sees a placeholder address — an admin fills in the real address and enables
-- them from the admin panel.
INSERT INTO payment_methods (slug, name, icon, status, address, instructions, sort_order) VALUES
  ('binance_pay', 'Binance Pay', '🅱️', 'DISABLED', '(address set in admin panel)', 'Send with Pay ID. After paying, send the order/transaction ID.', 10),
  ('usdt_trc20',  'USDT (TRC-20)', '💠', 'DISABLED', '(address set in admin panel)', 'TRON network only. After paying, send the transaction hash (TXID).', 20);
