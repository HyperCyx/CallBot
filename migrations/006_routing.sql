-- =============================================================================
-- 006 - DID -> SIP routing mappings + FreePBX sync jobs (spec §13, §15, §31, §36)
-- =============================================================================
-- The authoritative chain is:
--   numbers.phone_number -> inbound_route_mappings -> FreePBX inbound route
--                                            destination -> PJSIP/<extension>
--
-- inbound_route_mappings mirrors what the PBX actually holds, so the
-- reconciliation worker can compare "intended" (DB) vs "actual" (PBX) and
-- report drift instead of guessing.
-- =============================================================================

CREATE TABLE IF NOT EXISTS inbound_route_mappings (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number_id           uuid NOT NULL REFERENCES numbers(id) ON DELETE CASCADE,
  assignment_id       uuid REFERENCES number_assignments(id) ON DELETE SET NULL,
  -- FreePBX inbound route identifier: "<extension>/<cidnum>" per the official docs
  freepbx_route_id    text,
  did_match_pattern   text NOT NULL,          -- extension field sent to the PBX
  cidnum              text NOT NULL DEFAULT '',   -- '' = any caller
  destination         text NOT NULL,          -- e.g. from-did-direct,10194,1
  destination_extension text,                 -- parsed out for fast drift checks
  description         text,
  status              text NOT NULL DEFAULT 'PENDING'
                      CHECK (status IN ('PENDING','ACTIVE','DISABLED','REMOVED','ERROR')),
  last_applied_at    timestamptz,
  last_verify_at      timestamptz,
  last_error          text,
  drift_state         text CHECK (drift_state IN ('OK','MISSING_IN_PBX','MISMATCH','STALE_IN_DB')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  -- one live mapping per DID pattern
  deleted_at          timestamptz
);

-- At most one non-removed mapping per DID pattern.
CREATE UNIQUE INDEX IF NOT EXISTS uq_route_mapping_active
  ON inbound_route_mappings(did_match_pattern)
  WHERE deleted_at IS NULL AND status <> 'REMOVED';

CREATE INDEX IF NOT EXISTS idx_route_mappings_number     ON inbound_route_mappings(number_id);
CREATE INDEX IF NOT EXISTS idx_route_mappings_assignment ON inbound_route_mappings(assignment_id);
CREATE INDEX IF NOT EXISTS idx_route_mappings_status     ON inbound_route_mappings(status);

DROP TRIGGER IF EXISTS trg_route_mappings_updated_at ON inbound_route_mappings;
CREATE TRIGGER trg_route_mappings_updated_at BEFORE UPDATE ON inbound_route_mappings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- freepbx_sync_jobs: durable work queue for PBX side effects (spec §31, §36)
--
-- Every PBX mutation is written here BEFORE the HTTP call, then updated with
-- the result. This is what makes "FreePBX succeeded but the DB update failed"
-- recoverable: the job row + the route mapping row tell the reconciler exactly
-- what was attempted and how to converge.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS freepbx_sync_jobs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_type        text NOT NULL CHECK (job_type IN (
                    'EXTENSION_CREATE','EXTENSION_UPDATE','EXTENSION_DELETE',
                    'ROUTE_CREATE','ROUTE_UPDATE','ROUTE_DELETE',
                    'ROUTE_VERIFY','EXTENSION_VERIFY','CDR_FETCH','LIVE_CALLS_FETCH')),
  entity_type     text NOT NULL CHECK (entity_type IN ('number','assignment','sip_account','route','user','system')),
  entity_id       uuid,
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Idempotency: unique per logical operation so retries cannot double-apply.
  idempotency_key text NOT NULL,
  status          text NOT NULL DEFAULT 'PENDING'
                  CHECK (status IN ('PENDING','RUNNING','SUCCEEDED','FAILED','DEAD','CANCELLED')),
  attempts        integer NOT NULL DEFAULT 0,
  max_attempts    integer NOT NULL DEFAULT 5,
  priority        integer NOT NULL DEFAULT 100,
  next_run_at     timestamptz NOT NULL DEFAULT now(),
  locked_at       timestamptz,
  locked_by       text,
  last_error      text,
  result          jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  CONSTRAINT freepbx_sync_jobs_idem_unique UNIQUE (idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_sync_jobs_due       ON freepbx_sync_jobs(status, next_run_at) WHERE status IN ('PENDING','FAILED');
CREATE INDEX IF NOT EXISTS idx_sync_jobs_entity    ON freepbx_sync_jobs(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_sync_jobs_created   ON freepbx_sync_jobs(created_at DESC);

DROP TRIGGER IF EXISTS trg_sync_jobs_updated_at ON freepbx_sync_jobs;
CREATE TRIGGER trg_sync_jobs_updated_at BEFORE UPDATE ON freepbx_sync_jobs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- pbx_inventory_snapshot: last observed PBX state (extensions + routes).
-- Populated by the reconciliation worker. Lets the admin see "what the PBX has"
-- vs "what we think it has" without hammering the PBX API per dashboard render.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pbx_inventory_snapshot (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind          text NOT NULL CHECK (kind IN ('EXTENSION','INBOUND_ROUTE')),
  external_id   text NOT NULL,
  extension     text,
  cidnum        text,
  destination   text,
  description   text,
  raw           jsonb NOT NULL DEFAULT '{}'::jsonb,
  captured_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, external_id)
);

CREATE INDEX IF NOT EXISTS idx_pbx_snapshot_kind ON pbx_inventory_snapshot(kind, captured_at DESC);

-- -----------------------------------------------------------------------------
-- reconciliation_runs + findings (spec §31)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reconciliation_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  status          text NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING','COMPLETED','FAILED')),
  extensions_seen integer NOT NULL DEFAULT 0,
  routes_seen     integer NOT NULL DEFAULT 0,
  findings_count  integer NOT NULL DEFAULT 0,
  auto_fixed_count integer NOT NULL DEFAULT 0,
  error           text
);

CREATE TABLE IF NOT EXISTS reconciliation_findings (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id        uuid NOT NULL REFERENCES reconciliation_runs(id) ON DELETE CASCADE,
  severity      text NOT NULL CHECK (severity IN ('INFO','WARNING','CRITICAL')),
  finding_type  text NOT NULL,
  entity_type   text,
  entity_id     uuid,
  did           text,
  extension     text,
  detail        text NOT NULL,
  suggested_action text,
  auto_fixable  boolean NOT NULL DEFAULT false,
  resolved_at   timestamptz,
  resolved_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_findings_run      ON reconciliation_findings(run_id);
CREATE INDEX IF NOT EXISTS idx_findings_open     ON reconciliation_findings(severity, created_at DESC) WHERE resolved_at IS NULL;
