-- =============================================================================
-- 009 - operations: audit log, settings, idempotency, sessions, notifications
-- =============================================================================

-- -----------------------------------------------------------------------------
-- audit_logs (spec §28, §27)
--
-- Append-only AND tamper-evident: every row carries the hash of the previous
-- row, so deleting/altering history breaks the chain and is detectable.
-- UPDATE and DELETE are blocked by trigger.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_logs (
  id            bigserial PRIMARY KEY,
  actor_id      uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_telegram_id bigint,
  actor_type    text NOT NULL DEFAULT 'USER' CHECK (actor_type IN ('USER','ADMIN','SYSTEM','WORKER','API')),
  action        text NOT NULL,                       -- ASSIGN_NUMBER, APPROVE_USER, ...
  target_type   text,                                -- user | number | service | ...
  target_id     uuid,
  target_ref    text,                                -- human reference (DID, extension)
  result        text NOT NULL DEFAULT 'SUCCESS' CHECK (result IN ('SUCCESS','FAILURE','DENIED','PARTIAL')),
  reason        text,
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,   -- MUST NOT contain secrets
  request_id    text,
  ip            inet,
  user_agent    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  prev_hash     text,
  row_hash      text
);

CREATE INDEX IF NOT EXISTS idx_audit_created   ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_actor     ON audit_logs(actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action    ON audit_logs(action, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_target    ON audit_logs(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_audit_request   ON audit_logs(request_id);

DROP TRIGGER IF EXISTS trg_audit_no_update ON audit_logs;
CREATE TRIGGER trg_audit_no_update BEFORE UPDATE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION deny_mutation();

DROP TRIGGER IF EXISTS trg_audit_no_delete ON audit_logs;
CREATE TRIGGER trg_audit_no_delete BEFORE DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION deny_mutation();

-- Hash chain maintained in the database so application bugs cannot skip it.
CREATE OR REPLACE FUNCTION audit_logs_chain() RETURNS trigger AS $$
DECLARE
  prev text;
BEGIN
  SELECT row_hash INTO prev FROM audit_logs ORDER BY id DESC LIMIT 1;
  NEW.prev_hash := prev;
  NEW.row_hash := encode(digest(
      coalesce(prev, '')
      || NEW.action
      || coalesce(NEW.target_type, '')
      || coalesce(NEW.target_id::text, '')
      || coalesce(NEW.target_ref, '')
      || NEW.result
      || coalesce(NEW.actor_id::text, '')
      || coalesce(NEW.metadata::text, '')
      || NEW.created_at::text,
      'sha256'), 'hex');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_chain ON audit_logs;
CREATE TRIGGER trg_audit_chain BEFORE INSERT ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_chain();

-- -----------------------------------------------------------------------------
-- admin_settings (spec §22, §23, §24, §45)
-- Single source for every tunable business rule. Business logic reads from
-- here (with a small in-process cache) - nothing is hard-coded.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admin_settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  value_type  text NOT NULL DEFAULT 'string' CHECK (value_type IN ('string','number','boolean','json','secret_ref')),
  category    text NOT NULL DEFAULT 'general',
  label       text NOT NULL,
  description text,
  is_editable boolean NOT NULL DEFAULT true,
  updated_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_admin_settings_category ON admin_settings(category);

DROP TRIGGER IF EXISTS trg_admin_settings_updated_at ON admin_settings;
CREATE TRIGGER trg_admin_settings_updated_at BEFORE UPDATE ON admin_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- idempotency_keys (spec §27 "Idempotency keys")
-- Any mutating API call may present an Idempotency-Key; the stored response is
-- replayed on retry instead of re-executing the operation.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key           text PRIMARY KEY,
  scope         text NOT NULL,
  request_hash  text NOT NULL,
  status        text NOT NULL DEFAULT 'IN_PROGRESS' CHECK (status IN ('IN_PROGRESS','COMPLETED','FAILED')),
  response_code integer,
  response_body jsonb,
  actor_id      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL DEFAULT now() + interval '24 hours'
);

CREATE INDEX IF NOT EXISTS idx_idem_expiry ON idempotency_keys(expires_at);

-- -----------------------------------------------------------------------------
-- bot_sessions: persistent grammY session storage.
-- Survives restarts and works across multiple bot instances sharing one DB.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bot_sessions (
  key        text PRIMARY KEY,             -- "<chatId>:<userId>"
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_bot_sessions_expiry ON bot_sessions(expires_at) WHERE expires_at IS NOT NULL;

-- -----------------------------------------------------------------------------
-- notifications: durable outbox. Workers enqueue; the bot delivers; failures
-- retry. Used for expiry reminders, approvals, reconciliation alerts (§31, §32).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notifications (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid REFERENCES users(id) ON DELETE CASCADE,
  telegram_id  bigint,
  kind         text NOT NULL,
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key   text UNIQUE,
  status       text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','SENT','FAILED','CANCELLED')),
  attempts     integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  next_run_at  timestamptz NOT NULL DEFAULT now(),
  last_error   text,
  sent_at      timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notifications_due ON notifications(status, next_run_at) WHERE status IN ('PENDING','FAILED');

-- -----------------------------------------------------------------------------
-- worker_heartbeats: observability for the scheduled workers (§31, §32, §38)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS worker_heartbeats (
  worker      text PRIMARY KEY,
  instance    text,
  status      text NOT NULL DEFAULT 'IDLE' CHECK (status IN ('IDLE','RUNNING','ERROR')),
  last_run_at timestamptz,
  last_success_at timestamptz,
  last_error  text,
  run_count   bigint NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- freepbx_compat: cached result of the version/schema probe (spec §41)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS freepbx_compat (
  id                text PRIMARY KEY DEFAULT 'current',
  pbx_version       text,
  asterisk_version  text,
  api_module_version text,
  gql_schema_ok     boolean,
  supported_operations jsonb NOT NULL DEFAULT '[]'::jsonb,
  missing_operations jsonb NOT NULL DEFAULT '[]'::jsonb,
  detected_scope    text,
  detected_at       timestamptz,
  notes             text,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_freepbx_compat_updated_at ON freepbx_compat;
CREATE TRIGGER trg_freepbx_compat_updated_at BEFORE UPDATE ON freepbx_compat
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
