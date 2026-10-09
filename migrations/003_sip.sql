-- =============================================================================
-- 003 - sip_accounts
-- =============================================================================
-- One SIP/PJSIP extension per approved user (spec §5, §18).
-- The SIP password is stored ENCRYPTED (AES-256-GCM, key from SECRETS_KEK_BASE64)
-- in password_encrypted. It is decrypted only to render the owner's own
-- "SIP Information" screen; it is never logged and never sent to any other user.
-- =============================================================================

CREATE TABLE IF NOT EXISTS sip_accounts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  extension          text NOT NULL,                    -- e.g. 10194
  technology         text NOT NULL DEFAULT 'pjsip' CHECK (technology IN ('pjsip','sip')),
  sip_server         text,                             -- value shown to the user (host:port)
  sip_port           integer,
  sip_transport      text DEFAULT 'UDP' CHECK (sip_transport IN ('UDP','TCP','TLS','WSS')),
  sip_domain         text,
  display_name       text,
  email              text,
  caller_id          text,
  outbound_cid       text,
  voicemail_enabled  boolean NOT NULL DEFAULT false,
  -- Secrets: opaque ciphertext produced by src/lib/crypto.ts (v1:iv:tag:ct)
  password_encrypted text NOT NULL,
  um_password_encrypted text,
  vm_password_encrypted text,
  -- FreePBX identity / sync state
  freepbx_id         text,                             -- GraphQL id of the extension
  freepbx_device_id  text,
  status             text NOT NULL DEFAULT 'ACTIVE'
                     CHECK (status IN ('PROVISIONING','ACTIVE','SUSPENDED','DELETED','ERROR')),
  last_sync_at       timestamptz,
  last_sync_error    text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz,
  CONSTRAINT sip_accounts_extension_unique UNIQUE (extension)
);

CREATE INDEX IF NOT EXISTS idx_sip_accounts_user   ON sip_accounts(user_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_sip_accounts_status ON sip_accounts(status);

DROP TRIGGER IF EXISTS trg_sip_accounts_updated_at ON sip_accounts;
CREATE TRIGGER trg_sip_accounts_updated_at BEFORE UPDATE ON sip_accounts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- Extension allocation bookkeeping.
-- The advisory-lock-protected allocator (src/services/extension.service.ts)
-- takes a transaction-scoped advisory lock on EXTENSION_POOL_LOCK_KEY, then
-- picks the lowest free number inside the configured range. This table records
-- which extensions have ever been handed out so audit history survives even if
-- a sip_account row is deleted.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS extension_allocations (
  extension   text PRIMARY KEY,
  user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  allocated_at timestamptz NOT NULL DEFAULT now(),
  released_at  timestamptz,
  reason      text
);

CREATE INDEX IF NOT EXISTS idx_extension_allocations_user ON extension_allocations(user_id);
