-- =============================================================================
-- 004 - catalog: countries, services, plans (+ plan access rules)
-- =============================================================================
-- NOTHING here is hard-coded in application logic (spec §8, §22, §25, §26, §45).
-- The Telegram menus are rendered from these tables at runtime.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- countries  (spec §26)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS countries (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  iso2        char(2) NOT NULL,
  iso3        char(3),
  dial_code   text NOT NULL,                 -- '971' (no plus)
  flag        text,                          -- emoji flag, mandatory for FX quality
  status      text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DISABLED')),
  sort_order  integer NOT NULL DEFAULT 100,
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz,
  CONSTRAINT countries_iso2_unique UNIQUE (iso2),
  CONSTRAINT countries_dial_code_digits CHECK (dial_code ~ '^[0-9]{1,4}$')
);

CREATE INDEX IF NOT EXISTS idx_countries_active ON countries(status, sort_order) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_countries_dial   ON countries(dial_code);

DROP TRIGGER IF EXISTS trg_countries_updated_at ON countries;
CREATE TRIGGER trg_countries_updated_at BEFORE UPDATE ON countries
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- services (spec §9, §25)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS services (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        citext NOT NULL UNIQUE,        -- stable key for API/automation
  name        text NOT NULL,
  description text,
  icon        text,                          -- emoji or short label
  status      text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DISABLED')),
  sort_order  integer NOT NULL DEFAULT 100,
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);

CREATE INDEX IF NOT EXISTS idx_services_active ON services(status, sort_order) WHERE deleted_at IS NULL;

DROP TRIGGER IF EXISTS trg_services_updated_at ON services;
CREATE TRIGGER trg_services_updated_at BEFORE UPDATE ON services
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- service_countries: where a service is sold, per-country pricing, inventory
-- rules (spec §25). A country with zero ACTIVE rows here has no offer.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS service_countries (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id   uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  country_id   uuid NOT NULL REFERENCES countries(id) ON DELETE CASCADE,
  status       text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DISABLED')),
  price_cents  integer CHECK (price_cents IS NULL OR price_cents >= 0),
  currency     char(3) NOT NULL DEFAULT 'EUR',
  -- inventory rules: how many numbers a single user may hold for this offer
  max_per_user integer CHECK (max_per_user IS NULL OR max_per_user > 0),
  requires_premium boolean NOT NULL DEFAULT false,
  notes        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (service_id, country_id)
);

CREATE INDEX IF NOT EXISTS idx_service_countries_country ON service_countries(country_id, status);

DROP TRIGGER IF EXISTS trg_service_countries_updated_at ON service_countries;
CREATE TRIGGER trg_service_countries_updated_at BEFORE UPDATE ON service_countries
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- plans (spec §22) - rules are data.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS plans (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                  citext NOT NULL UNIQUE,   -- 'free','premium', or custom
  name                  text NOT NULL,
  description           text,
  is_active             boolean NOT NULL DEFAULT true,
  is_default            boolean NOT NULL DEFAULT false,
  rank                  integer NOT NULL DEFAULT 0,   -- higher = more privileged
  max_numbers           integer NOT NULL DEFAULT 1 CHECK (max_numbers >= 0),
  max_numbers_per_country integer,
  allows_premium_numbers boolean NOT NULL DEFAULT false,
  allows_test_number    boolean NOT NULL DEFAULT true,
  price_cents_per_month integer NOT NULL DEFAULT 0 CHECK (price_cents_per_month >= 0),
  currency              char(3) NOT NULL DEFAULT 'EUR',
  duration_days         integer NOT NULL DEFAULT 30,   -- plan period / user expiry
  number_expiry_days    integer,                       -- null = follow global default
  features              jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  deleted_at            timestamptz
);

-- Only one default plan may exist at a time.
CREATE UNIQUE INDEX IF NOT EXISTS idx_plans_single_default
  ON plans(is_default) WHERE is_default AND deleted_at IS NULL;

DROP TRIGGER IF EXISTS trg_plans_updated_at ON plans;
CREATE TRIGGER trg_plans_updated_at BEFORE UPDATE ON plans
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- plan -> country access (spec §22 "Country access")
CREATE TABLE IF NOT EXISTS plan_countries (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id    uuid NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  country_id uuid NOT NULL REFERENCES countries(id) ON DELETE CASCADE,
  allowed    boolean NOT NULL DEFAULT true,
  max_numbers integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plan_id, country_id)
);

DROP TRIGGER IF EXISTS trg_plan_countries_updated_at ON plan_countries;
CREATE TRIGGER trg_plan_countries_updated_at BEFORE UPDATE ON plan_countries
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- plan -> service access (spec §22 "Service access")
CREATE TABLE IF NOT EXISTS plan_services (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id     uuid NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  service_id  uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  allowed     boolean NOT NULL DEFAULT true,
  max_numbers integer,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plan_id, service_id)
);

DROP TRIGGER IF EXISTS trg_plan_services_updated_at ON plan_services;
CREATE TRIGGER trg_plan_services_updated_at BEFORE UPDATE ON plan_services
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- users.plan_id FK (declared in 002 before plans existed)
DO $$ BEGIN
  ALTER TABLE users
    ADD CONSTRAINT users_plan_id_fkey FOREIGN KEY (plan_id) REFERENCES plans(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE users
    ADD CONSTRAINT users_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES users(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
