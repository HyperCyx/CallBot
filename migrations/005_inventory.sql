-- =============================================================================
-- 005 - number inventory + assignments (spec §10, §12, §14, §15, §16, §17)
-- =============================================================================
-- THE concurrency-critical part of the platform.
--
-- Two independent guards make double-assignment impossible:
--
--   1. `numbers.status = 'AVAILABLE'` is checked with SELECT ... FOR UPDATE
--      SKIP LOCKED inside the allocating transaction, so two concurrent
--      "Get Number" taps cannot read the same row.
--
--   2. `uq_number_assignments_active` - a partial unique index that allows at
--      most ONE row with released_at IS NULL per number. Even if application
--      logic were bypassed (manual SQL, a bug, a retry storm), the database
--      physically refuses a second active assignment.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- numbers (spec §10)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS numbers (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Canonical E.164, always with '+'. This is the human/API identity.
  phone_number       text NOT NULL,
  -- The exact string FreePBX must match on the trunk (see src/lib/phone.ts).
  -- Kept in sync by the application whenever phone_number changes.
  did_match_pattern  text,
  country_id         uuid NOT NULL REFERENCES countries(id) ON DELETE RESTRICT,
  service_id         uuid NOT NULL REFERENCES services(id) ON DELETE RESTRICT,
  provider           text,                      -- carrier/supplier this DID is leased from
  status             text NOT NULL DEFAULT 'AVAILABLE'
                     CHECK (status IN ('AVAILABLE','RESERVED','ASSIGNED','SUSPENDED','EXPIRED','DISABLED')),
  plan_type          text NOT NULL DEFAULT 'FREE' CHECK (plan_type IN ('FREE','PREMIUM')),
  price_cents        integer CHECK (price_cents IS NULL OR price_cents >= 0),
  currency           char(3) NOT NULL DEFAULT 'EUR',
  -- current holder (denormalised for fast queries; history lives in number_assignments)
  assigned_user_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  assigned_at        timestamptz,
  sip_extension      text,
  -- reservation bookkeeping so a crashed worker cannot strand inventory
  reserved_at        timestamptz,
  reserved_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  reservation_expires_at timestamptz,
  -- lifecycle
  status_reason      text,
  expiration_date    date,
  last_route_sync_at timestamptz,
  metadata           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_numbers_phone_active
  ON numbers(phone_number) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_numbers_pick
  ON numbers(country_id, service_id, plan_type, status)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_numbers_status          ON numbers(status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_numbers_assigned_user   ON numbers(assigned_user_id) WHERE assigned_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_numbers_did_match       ON numbers(did_match_pattern);
CREATE INDEX IF NOT EXISTS idx_numbers_expiration      ON numbers(expiration_date) WHERE expiration_date IS NOT NULL;

DROP TRIGGER IF EXISTS trg_numbers_updated_at ON numbers;
CREATE TRIGGER trg_numbers_updated_at BEFORE UPDATE ON numbers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- number_assignments: full history, one ACTIVE row per number (spec §12, §15, §35)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS number_assignments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number_id         uuid NOT NULL REFERENCES numbers(id) ON DELETE CASCADE,
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  sip_account_id    uuid REFERENCES sip_accounts(id) ON DELETE SET NULL,
  sip_extension     text,
  -- lifecycle of this assignment
  assigned_at       timestamptz NOT NULL DEFAULT now(),
  assigned_by       uuid REFERENCES users(id) ON DELETE SET NULL,   -- admin for manual assigns
  assignment_source text NOT NULL DEFAULT 'USER' CHECK (assignment_source IN ('USER','ADMIN','API','IMPORT','MIGRATION')),
  released_at       timestamptz,
  released_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  release_reason    text,
  -- terms snapshot at assignment time (auditable pricing/T&Cs)
  plan_id           uuid REFERENCES plans(id) ON DELETE SET NULL,
  plan_type         text CHECK (plan_type IN ('FREE','PREMIUM')),
  price_cents       integer,
  currency          char(3),
  expires_at        timestamptz,
  -- PBX side effects
  freepbx_route_id  text,
  route_synced_at   timestamptz,
  status            text NOT NULL DEFAULT 'ACTIVE'
                    CHECK (status IN ('RESERVING','ACTIVE','SUSPENDED','RELEASED','FAILED')),
  failure_reason    text,
  metadata          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- THE invariant: at most one non-released assignment per number.
CREATE UNIQUE INDEX IF NOT EXISTS uq_number_assignments_active
  ON number_assignments(number_id)
  WHERE released_at IS NULL AND status <> 'RELEASED' AND status <> 'FAILED';

CREATE INDEX IF NOT EXISTS idx_number_assignments_user    ON number_assignments(user_id, assigned_at DESC);
CREATE INDEX IF NOT EXISTS idx_number_assignments_number  ON number_assignments(number_id, assigned_at DESC);
CREATE INDEX IF NOT EXISTS idx_number_assignments_active  ON number_assignments(user_id) WHERE released_at IS NULL;

DROP TRIGGER IF EXISTS trg_number_assignments_updated_at ON number_assignments;
CREATE TRIGGER trg_number_assignments_updated_at BEFORE UPDATE ON number_assignments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- number_import_batches: result of every CSV / bulk import from Telegram (§11)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS number_import_batches (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id        uuid REFERENCES users(id) ON DELETE SET NULL,
  country_id      uuid REFERENCES countries(id) ON DELETE SET NULL,
  service_id      uuid REFERENCES services(id) ON DELETE SET NULL,
  plan_type       text CHECK (plan_type IN ('FREE','PREMIUM')),
  source          text NOT NULL DEFAULT 'CSV' CHECK (source IN ('CSV','SINGLE','BULK','API','UPLOAD')),
  original_name   text,
  total_rows      integer NOT NULL DEFAULT 0,
  imported_count  integer NOT NULL DEFAULT 0,
  duplicate_count integer NOT NULL DEFAULT 0,
  invalid_count   integer NOT NULL DEFAULT 0,
  skipped_count   integer NOT NULL DEFAULT 0,
  errors          jsonb NOT NULL DEFAULT '[]'::jsonb,
  status          text NOT NULL DEFAULT 'COMPLETED' CHECK (status IN ('RUNNING','COMPLETED','FAILED')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz
);

CREATE INDEX IF NOT EXISTS idx_import_batches_created ON number_import_batches(created_at DESC);

-- -----------------------------------------------------------------------------
-- Convenience view: inventory by offer (used by Get Number menus + dashboard)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_offer_inventory AS
SELECT
  c.id   AS country_id,
  c.name AS country_name,
  c.flag AS country_flag,
  c.dial_code,
  s.id   AS service_id,
  s.name AS service_name,
  s.icon AS service_icon,
  n.plan_type,
  count(*) FILTER (WHERE n.status = 'AVAILABLE')  AS available_count,
  count(*) FILTER (WHERE n.status = 'ASSIGNED')   AS assigned_count,
  count(*) FILTER (WHERE n.status = 'SUSPENDED')  AS suspended_count,
  count(*) FILTER (WHERE n.status IN ('AVAILABLE','ASSIGNED','SUSPENDED')) AS total_count
FROM numbers n
JOIN countries c ON c.id = n.country_id
JOIN services  s ON s.id = n.service_id
WHERE n.deleted_at IS NULL
GROUP BY c.id, c.name, c.flag, c.dial_code, s.id, s.name, s.icon, n.plan_type;
