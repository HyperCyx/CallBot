-- =============================================================================
-- 002 - identity: users, telegram_accounts, roles, user_roles
-- =============================================================================
-- Flow modelled here (spec §4/§5):
--   captcha solved -> PENDING -> admin approves -> ACTIVE (+ SIP account)
-- Every state change writes to audit_logs (see 009).
-- =============================================================================

-- users.status lifecycle: PENDING -> ACTIVE -> (BLOCKED | EXPIRED | DELETED)
DO $$ BEGIN
  CREATE DOMAIN user_status AS text
    CHECK (VALUE IN ('PENDING','ACTIVE','BLOCKED','EXPIRED','DELETED'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_id    bigint UNIQUE,                      -- nullable: users can exist from admin/API import
  username       citext,
  display_name   text,
  language_code  text NOT NULL DEFAULT 'en',
  email          text,
  status         text NOT NULL DEFAULT 'PENDING'
                 CHECK (status IN ('PENDING','ACTIVE','BLOCKED','EXPIRED','DELETED')),
  plan_id        uuid,                               -- FK added in 004 (plans)
  referral_code  citext UNIQUE,
  referred_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  referral_qualified_at timestamptz,
  notes          text,
  -- Admin-visible metadata only. NEVER secrets.
  metadata       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  approved_at    timestamptz,
  approved_by    uuid,
  blocked_at     timestamptz,
  blocked_reason text,
  expires_at     timestamptz,
  last_seen_at   timestamptz,
  deleted_at     timestamptz
);

CREATE INDEX IF NOT EXISTS idx_users_status            ON users(status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_users_plan              ON users(plan_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_users_telegram_id       ON users(telegram_id) WHERE telegram_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_referred_by       ON users(referred_by) WHERE referred_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_expiry            ON users(expires_at) WHERE expires_at IS NOT NULL AND deleted_at IS NULL;

DROP TRIGGER IF EXISTS trg_users_updated_at ON users;
CREATE TRIGGER trg_users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- telegram_accounts: one row per Telegram identity seen by the bot.
-- Kept separate from `users` so we can record pre-registration activity
-- (anti-abuse: captcha attempts, spam, blocked-before-approval) without
-- creating a user record for every stranger who opens the bot.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS telegram_accounts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_id     bigint NOT NULL UNIQUE,
  user_id         uuid REFERENCES users(id) ON DELETE SET NULL,
  chat_id         bigint,
  username        citext,
  first_name      text,
  last_name       text,
  language_code   text,
  is_bot          boolean NOT NULL DEFAULT false,
  -- verification / gatekeeping (spec §4)
  captcha_passed_at     timestamptz,
  captcha_attempts      integer NOT NULL DEFAULT 0,
  membership_checked_at timestamptz,
  membership_ok         boolean,
  banned          boolean NOT NULL DEFAULT false,
  ban_reason      text,
  last_update_id  bigint,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_telegram_accounts_user ON telegram_accounts(user_id);

DROP TRIGGER IF EXISTS trg_telegram_accounts_updated_at ON telegram_accounts;
CREATE TRIGGER trg_telegram_accounts_updated_at BEFORE UPDATE ON telegram_accounts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- RBAC (spec §27): roles are data, not code.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS roles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        citext NOT NULL UNIQUE,     -- 'super_admin','admin','support','user'
  name        text NOT NULL,
  description text,
  -- permission strings, e.g. ["numbers:import","users:approve","*"]
  permissions jsonb NOT NULL DEFAULT '[]'::jsonb,
  is_system   boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_roles_updated_at ON roles;
CREATE TRIGGER trg_roles_updated_at BEFORE UPDATE ON roles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS user_roles (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id    uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  granted_by uuid REFERENCES users(id) ON DELETE SET NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  UNIQUE (user_id, role_id)
);

CREATE INDEX IF NOT EXISTS idx_user_roles_user ON user_roles(user_id);
CREATE INDEX IF NOT EXISTS idx_user_roles_role ON user_roles(role_id);
