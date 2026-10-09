-- -----------------------------------------------------------------------------
-- 013: recycle SIP extensions after a deleted account.
--
-- `sip_accounts_extension_unique` was an unconditional UNIQUE (extension), which
-- made a **deleted** account block its extension forever: the allocator hands
-- out released extensions from the pool (that is the whole point of
-- `extension_allocations.released_at`), and the insert then collided with the
-- historical row. In practice the pool drained itself - after four provision /
-- delete cycles no user could be provisioned at all ("duplicate key value
-- violates unique constraint sip_accounts_extension_unique").
--
-- The rule we actually want is: at most one **live** account per extension.
-- History rows keep their extension for audit, so the constraint becomes a
-- partial unique index on the live set - mirroring `findFreeExtension()`, which
-- already ignores soft-deleted rows.
--
-- The same reasoning applies to a user: one live SIP account per account, but
-- re-provisioning after deletion must be possible.
-- -----------------------------------------------------------------------------

ALTER TABLE sip_accounts DROP CONSTRAINT IF EXISTS sip_accounts_extension_unique;

CREATE UNIQUE INDEX IF NOT EXISTS uq_sip_accounts_extension_live
  ON sip_accounts (extension) WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_sip_accounts_user_live
  ON sip_accounts (user_id) WHERE deleted_at IS NULL;

COMMENT ON INDEX uq_sip_accounts_extension_live IS
  'One live SIP account per extension; deleted accounts keep their extension as history and may be recycled (see provisionSipAccount).';
