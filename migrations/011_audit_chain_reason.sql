-- =============================================================================
-- 011 - strengthen the audit hash chain
-- =============================================================================
-- Two gaps in the v1 chain (see 009_ops.sql):
--
--  1. `reason` was NOT hashed. Anyone able to disable triggers (a DBA, or an
--     attacker with DB access) could rewrite why an action was denied without
--     breaking the chain. `reason` is exactly the field that explains a DENIED
--     or a suspension, so it must be covered.
--  2. There was no serialisation between concurrent inserts: two inserts in
--     parallel could both read the same predecessor row and fork the chain
--     (verification then reports a false break). A transaction-scoped advisory
--     lock, taken in a trigger that fires BEFORE the chain trigger, fixes this.
--
-- Trigger firing order is alphabetical by name, so the lock trigger is named
-- `trg_audit_0_lock` to sort before `trg_audit_chain`.
--
-- `verifyAuditChain()` in src/db/migrate.ts uses the identical formula and is
-- changed together with this migration. NEVER edit 009 - migrations are
-- checksum-verified; supersede with a new file instead.
-- =============================================================================

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
      || coalesce(NEW.reason, '')          -- v2: reason is part of the chain
      || coalesce(NEW.actor_id::text, '')
      || coalesce(NEW.metadata::text, '')
      || NEW.created_at::text,
      'sha256'), 'hex');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Serialises concurrent inserts for the duration of the transaction. The lock
-- is released on COMMIT/ROLLBACK, so when the next insert proceeds its
-- predecessor is guaranteed to be committed and visible.
CREATE OR REPLACE FUNCTION audit_logs_chain_lock() RETURNS trigger AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('audit_logs_chain'));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_chain_lock ON audit_logs;
DROP TRIGGER IF EXISTS trg_audit_0_lock ON audit_logs;
CREATE TRIGGER trg_audit_0_lock BEFORE INSERT ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_chain_lock();
