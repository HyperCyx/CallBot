-- =============================================================================
-- 007 - calls: live sessions (AMI) and historical CDR
-- =============================================================================
-- EXPLICIT SEPARATION (spec §20):
--
--   call_sessions  = LIVE, volatile, sourced from Asterisk AMI (Newchannel /
--                    Newstate / Hangup events). Never from CDR.
--   call_history   = HISTORICAL, immutable, sourced from the documented
--                    FreePBX GraphQL `fetchAllCdrs` / `fetchCdr` queries.
--
-- CDR is written by Asterisk when a call finishes and therefore cannot be used
-- to show a call that is still ringing. The two are never conflated.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- call_history: local mirror of CDR (enables fast per-user filtering by DID,
-- which the PBX CDR API does not support directly - we can only page it).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS call_history (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- PBX-side identity
  uniqueid       text NOT NULL,
  linkedid       text,
  freepbx_cdr_id text,
  -- call facts
  calldate       timestamptz NOT NULL,
  clid           text,
  src            text,
  dst            text,
  did            text,                 -- our DID, normalised to E.164 when matched
  dcontext       text,
  channel        text,
  dstchannel     text,
  lastapp        text,
  lastdata       text,
  duration       integer NOT NULL DEFAULT 0,
  billsec        integer NOT NULL DEFAULT 0,
  disposition    text,                 -- ANSWERED | NO ANSWER | BUSY | FAILED
  direction      text CHECK (direction IN ('INBOUND','OUTBOUND','INTERNAL','UNKNOWN')),
  recordingfile  text,
  amaflags       text,
  -- resolved ownership (nullable: a call may not belong to any local user)
  number_id      uuid REFERENCES numbers(id) ON DELETE SET NULL,
  user_id        uuid REFERENCES users(id) ON DELETE SET NULL,
  sip_extension  text,
  raw            jsonb NOT NULL DEFAULT '{}'::jsonb,
  ingested_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT call_history_uniqueid_unique UNIQUE (uniqueid)
);

CREATE INDEX IF NOT EXISTS idx_call_history_user   ON call_history(user_id, calldate DESC);
CREATE INDEX IF NOT EXISTS idx_call_history_number ON call_history(number_id, calldate DESC);
CREATE INDEX IF NOT EXISTS idx_call_history_date   ON call_history(calldate DESC);
CREATE INDEX IF NOT EXISTS idx_call_history_did    ON call_history(did);
CREATE INDEX IF NOT EXISTS idx_call_history_linked ON call_history(linkedid);

-- -----------------------------------------------------------------------------
-- call_sessions: live snapshot maintained from AMI events.
-- Rows are removed when Hangup is observed; stale rows are swept by the worker
-- (a channel that vanished without a Hangup event, e.g. after a reload).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS call_sessions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel        text NOT NULL,
  uniqueid       text,
  linkedid       text,
  caller         text,
  connected_to   text,
  did            text,
  direction      text CHECK (direction IN ('INBOUND','OUTBOUND','INTERNAL','UNKNOWN')),
  state          text,                 -- Ringing | Up | Dialing | ...
  started_at     timestamptz NOT NULL DEFAULT now(),
  answered_at    timestamptz,
  last_event_at  timestamptz NOT NULL DEFAULT now(),
  number_id      uuid REFERENCES numbers(id) ON DELETE SET NULL,
  user_id        uuid REFERENCES users(id) ON DELETE SET NULL,
  sip_extension  text,
  raw            jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT call_sessions_channel_unique UNIQUE (channel)
);

CREATE INDEX IF NOT EXISTS idx_call_sessions_user   ON call_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_call_sessions_number ON call_sessions(number_id);
CREATE INDEX IF NOT EXISTS idx_call_sessions_active ON call_sessions(state, last_event_at DESC);

-- -----------------------------------------------------------------------------
-- cdr_sync_state: bookmark for incremental CDR ingestion (avoids re-paging the
-- whole CDR table on every poll).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cdr_sync_state (
  id             text PRIMARY KEY DEFAULT 'default',
  last_synced_at timestamptz,
  last_calldate  timestamptz,
  last_page      integer NOT NULL DEFAULT 0,
  total_imported bigint NOT NULL DEFAULT 0,
  last_error     text,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_cdr_sync_state_updated_at ON cdr_sync_state;
CREATE TRIGGER trg_cdr_sync_state_updated_at BEFORE UPDATE ON cdr_sync_state
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
