-- =============================================================================
-- 001 - extensions, helper functions, updated_at trigger
-- =============================================================================
-- Application source of truth: PostgreSQL (spec §35, §45).
-- UUID primary keys, foreign keys, unique constraints, indexes, soft delete.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid(), digest()
CREATE EXTENSION IF NOT EXISTS citext;     -- case-insensitive text (usernames, codes)

-- -----------------------------------------------------------------------------
-- updated_at maintenance
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- -----------------------------------------------------------------------------
-- Utility: default UUID v4 primary key
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION uuid_generate_v4_compat() RETURNS uuid AS $$
  SELECT gen_random_uuid();
$$ LANGUAGE sql VOLATILE;

-- -----------------------------------------------------------------------------
-- Utility: normalise a raw phone string to E.164 as best as SQL can.
-- The authoritative normalisation lives in the application (src/lib/phone.ts);
-- this is a safety net for ad-hoc SQL and import validation.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION try_normalize_e164(raw text) RETURNS text AS $$
DECLARE
  digits text;
BEGIN
  IF raw IS NULL THEN RETURN NULL; END IF;
  digits := regexp_replace(raw, '[^0-9]', '', 'g');
  IF digits LIKE '00%' THEN
    digits := substring(digits from 3);
  END IF;
  IF length(digits) < 7 OR length(digits) > 15 THEN
    RETURN NULL;
  END IF;
  RETURN '+' || digits;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- -----------------------------------------------------------------------------
-- Guard: prevent mutation of append-only tables (audit trail integrity, §28)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION deny_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Table % is append-only; % is not permitted', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;
