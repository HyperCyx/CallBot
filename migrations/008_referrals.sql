-- =============================================================================
-- 008 - referral system (spec §23)
-- =============================================================================
-- Anti-abuse invariants enforced in the database:
--   * users.referral_code is UNIQUE
--   * referrals.referred_user_id is UNIQUE  -> a user can only ever be
--     credited to one referrer, exactly once (no duplicate credit, no loops)
--   * CHECK (referrer_user_id <> referred_user_id) -> no self-referral
--   * referral_commissions has a unique (referral_id, kind) so the same
--     commission cannot be paid twice.
-- =============================================================================

CREATE TABLE IF NOT EXISTS referral_codes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code         citext NOT NULL UNIQUE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  is_active    boolean NOT NULL DEFAULT true,
  clicks       integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_referral_codes_user ON referral_codes(user_id) WHERE is_active;

DROP TRIGGER IF EXISTS trg_referral_codes_updated_at ON referral_codes;
CREATE TRIGGER trg_referral_codes_updated_at BEFORE UPDATE ON referral_codes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- referrals: one row per referred user (UNAMBIGUOUS single credit)
CREATE TABLE IF NOT EXISTS referrals (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_user_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  referred_user_id  uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  referral_code     citext NOT NULL,
  -- status machine: PENDING (registered) -> QUALIFIED (met the qualification
  -- rule) -> PAID / REJECTED (fraud, chargeback, refund)
  status            text NOT NULL DEFAULT 'PENDING'
                    CHECK (status IN ('PENDING','QUALIFIED','REJECTED','PAID')),
  qualification_rule text,
  qualified_at      timestamptz,
  rejected_reason   text,
  -- abuse signals
  same_ip_hash      text,
  risk_score        integer NOT NULL DEFAULT 0,
  metadata          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT referrals_no_self CHECK (referrer_user_id <> referred_user_id)
);

CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(referrer_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_referrals_status   ON referrals(status);

DROP TRIGGER IF EXISTS trg_referrals_updated_at ON referrals;
CREATE TRIGGER trg_referrals_updated_at BEFORE UPDATE ON referrals
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS referral_commissions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  referral_id    uuid NOT NULL REFERENCES referrals(id) ON DELETE CASCADE,
  referrer_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- how it was calculated, snapshotted so history stays truthful after config changes
  commission_type text NOT NULL CHECK (commission_type IN ('FIXED','PERCENTAGE')),
  rate_value     numeric(12,4) NOT NULL,     -- e.g. 10.0000 (%) or 2.0000 (EUR)
  base_amount_cents integer,                  -- what the percentage applied to
  amount_cents   integer NOT NULL CHECK (amount_cents >= 0),
  currency       char(3) NOT NULL DEFAULT 'EUR',
  source         text NOT NULL DEFAULT 'SIGNUP' CHECK (source IN ('SIGNUP','RENEWAL','MANUAL')),
  status         text NOT NULL DEFAULT 'PENDING'
                 CHECK (status IN ('PENDING','APPROVED','PAID','REVERSED')),
  note           text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  paid_at        timestamptz,
  paid_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (referral_id, source)
);

CREATE INDEX IF NOT EXISTS idx_commissions_referrer ON referral_commissions(referrer_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_commissions_status   ON referral_commissions(status);

-- Referral balance view (spec §24 "Referral Balance")
CREATE OR REPLACE VIEW v_referral_balances AS
SELECT
  u.id AS user_id,
  u.telegram_id,
  u.username,
  COALESCE(sum(c.amount_cents) FILTER (WHERE c.status IN ('PENDING','APPROVED')), 0) AS pending_cents,
  COALESCE(sum(c.amount_cents) FILTER (WHERE c.status = 'PAID'), 0)                  AS paid_cents,
  count(DISTINCT r.id)                                                              AS referral_count,
  count(DISTINCT r.id) FILTER (WHERE r.status IN ('QUALIFIED','PAID'))              AS qualified_count
FROM users u
LEFT JOIN referrals r ON r.referrer_user_id = u.id
LEFT JOIN referral_commissions c ON c.referrer_user_id = u.id
GROUP BY u.id, u.telegram_id, u.username;
