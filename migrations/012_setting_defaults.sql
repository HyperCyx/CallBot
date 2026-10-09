-- =============================================================================
-- 012 - setting defaults snapshot + seed helpers
-- =============================================================================
-- Why this exists:
--
--  * `admin_settings` has a foreign key to `users` (updated_by). Any maintenance
--    or test routine that TRUNCATEs `users` with CASCADE therefore also empties
--    the configuration table - silently, and with the defaults lost. The
--    defaults are data, not business logic, so this migration declares them
--    explicitly and exposes an idempotent restore function.
--
--  * The deployment seed script (`npm run seed`) and the test harness both call
--    `seed_admin_settings()`, so there is exactly one definition of "the
--    defaults that ship with this release".
--
-- Semantics: `setting_defaults` is a *default*, never a source of truth at
-- runtime - runtime reads always go through admin_settings, and restoring never
-- overwrites a value an operator has changed.
-- =============================================================================

CREATE TABLE IF NOT EXISTS setting_defaults (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  value_type  text NOT NULL DEFAULT 'string',
  category    text NOT NULL DEFAULT 'general',
  label       text NOT NULL,
  description text,
  is_editable boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- The shipped defaults are data, not business logic: they are declared here so
-- any database (fresh, or one whose admin_settings rows were lost to a
-- maintenance TRUNCATE ... CASCADE) can be made complete again. Values match the
-- release's initial configuration; runtime reads always come from admin_settings.
INSERT INTO setting_defaults (key, value, value_type, category, label, description, is_editable)
SELECT v.key, v.value::jsonb, v.value_type, v.category, v.label, v.description, true
FROM (VALUES
  ('bot.registration_enabled', 'true', 'boolean', 'registration', 'Registration open',
  'When false, /start shows a closed-registration notice.'),
  ('bot.require_channel_membership', 'false', 'boolean', 'registration', 'Require channel membership',
  'Check membership of the configured channel before allowing registration.'),
  ('bot.captcha_enabled', 'true', 'boolean', 'registration', 'CAPTCHA on /start',
  'Ask a simple arithmetic question before the approval request is sent.'),
  ('bot.auto_approve', 'false', 'boolean', 'registration', 'Auto-approve new users',
  'DANGEROUS: approves users without admin review and provisions SIP immediately.'),
  ('test_number.enabled', 'true', 'boolean', 'numbers', 'Provide test number',
  'Give each approved user a shared test number to verify their SIP account.'),
  ('test_number.value', '""', 'string', 'numbers', 'Test number',
  'The DID used purely for SIP verification. Not part of user inventory.'),
  ('numbers.max_requests_per_minute', '5', 'number', 'numbers', 'Get Number rate limit',
  'Maximum assignment requests per user per minute.'),
  ('numbers.auto_release_on_expiry', 'false', 'boolean', 'numbers', 'Auto-release on expiry',
  'When false (recommended) expired numbers are only suspended and flagged; an admin releases them.'),
  ('numbers.allow_user_release', 'true', 'boolean', 'numbers', 'Allow user self-release',
  'Let users release their own numbers back to inventory.'),
  ('numbers.require_confirmation', 'false', 'boolean', 'numbers', 'Confirm assignment',
  'ON = country -> service -> "Assign number" confirmation -> assigned. OFF (default) = tapping a service assigns the number immediately.'),
  ('referral.enabled', 'true', 'boolean', 'referral', 'Referral program enabled',
  'Master switch for the referral programme.'),
  ('referral.commission_type', '"PERCENTAGE"', 'string', 'referral', 'Commission type',
  'FIXED (per qualified referral) or PERCENTAGE (of the plan price).'),
  ('referral.commission_value', '10', 'number', 'referral', 'Commission value',
  'Percentage (0-100) or fixed amount in the configured currency.'),
  ('referral.currency', '"EUR"', 'string', 'referral', 'Commission currency', 'ISO-4217 code.'),
  ('referral.qualification_rule', '"FIRST_NUMBER_ASSIGNED"', 'string', 'referral', 'Qualification rule',
  'SIGNUP | USER_APPROVED | FIRST_NUMBER_ASSIGNED | PLAN_PURCHASED.'),
  ('referral.max_per_referrer_per_day', '20', 'number', 'referral', 'Daily referral cap',
  'Maximum qualified referrals credited per referrer per day (anti-abuse).'),
  ('referral.hold_hours', '72', 'number', 'referral', 'Payout hold',
  'Hours a commission stays PENDING before it may be approved.'),
  ('calls.history_page_size', '10', 'number', 'calls', 'Call history page size', 'Rows per page.'),
  ('calls.show_recording_links', 'false', 'boolean', 'calls', 'Show recording links',
  'Reveal recording file paths to users.'),
  ('security.enforce_https_only', 'true', 'boolean', 'security', 'HTTPS only',
  'Refuse to start the HTTP API without TLS termination in front of it (production).'),
  ('security.max_captcha_attempts', '3', 'number', 'security', 'CAPTCHA attempts',
  'Failed captcha attempts before the Telegram account is temporarily rejected.'),
  ('security.ip_allowlist_freebx', '""', 'string', 'security', 'FreePBX API allowlist',
  'Optional comma separated list of IPs allowed to call the FreePBX API.'),
  ('reconcile.auto_fix_safe', 'true', 'boolean', 'reconciliation', 'Auto-fix safe drift',
  'Automatically recreate missing routes and remove stale routes. Destructive fixes always require admin action.'),
  ('reconcile.alert_admins', 'true', 'boolean', 'reconciliation', 'Alert admins on drift',
  'Send Telegram alerts when reconciliation finds CRITICAL drift.'),
  ('reconcile.lookback_hours', '24', 'number', 'reconciliation', 'CDR lookback (hours)',
  'How far back the CDR ingestion job re-scans each run.')
) AS v(key, value, value_type, category, label, description)
ON CONFLICT (key) DO NOTHING;

-- Keeps the snapshot in step when a later migration adds new settings rows that
-- carry is_editable = true and are not yet in the snapshot.
CREATE OR REPLACE FUNCTION refresh_setting_defaults() RETURNS integer AS $$
DECLARE
  n integer;
BEGIN
  INSERT INTO setting_defaults (key, value, value_type, category, label, description, is_editable)
  SELECT s.key, s.value, s.value_type, s.category, s.label, s.description, s.is_editable
    FROM admin_settings s
  ON CONFLICT (key) DO UPDATE
    SET value = EXCLUDED.value,
        value_type = EXCLUDED.value_type,
        category = EXCLUDED.category,
        label = EXCLUDED.label,
        description = EXCLUDED.description,
        is_editable = EXCLUDED.is_editable;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$ LANGUAGE plpgsql;

-- Restores any missing setting. Never overwrites an existing row: an operator
-- (or the admin panel) may legitimately have changed a value.
CREATE OR REPLACE FUNCTION seed_admin_settings() RETURNS integer AS $$
DECLARE
  n integer;
BEGIN
  INSERT INTO admin_settings (key, value, value_type, category, label, description, is_editable)
  SELECT d.key, d.value, d.value_type, d.category, d.label, d.description, d.is_editable
    FROM setting_defaults d
  ON CONFLICT (key) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$ LANGUAGE plpgsql;

-- The system roles are referenced by the bot's authorisation checks and by the
-- bootstrap-admin allowlist; they are configuration too.
CREATE OR REPLACE FUNCTION seed_system_roles() RETURNS integer AS $$
DECLARE
  n integer;
BEGIN
  INSERT INTO roles (code, name, permissions, is_system) VALUES
    ('super_admin', 'Super Administrator', '["*"]'::jsonb, true),
    ('admin',       'Administrator',       '["users:*","numbers:*"]'::jsonb, true),
    ('support',     'Support',             '["users:read"]'::jsonb, true),
    ('user',        'End User',            '["self:read"]'::jsonb, true)
  ON CONFLICT (code) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$ LANGUAGE plpgsql;

-- Housekeeping: keep worker heartbeats and expired bot sessions from growing
-- without bound. Called by the job worker and by ops maintenance.
CREATE OR REPLACE FUNCTION prune_operational_rows(p_session_days integer DEFAULT 30) RETURNS jsonb AS $$
DECLARE
  sessions integer;
  heartbeats integer;
BEGIN
  DELETE FROM bot_sessions
   WHERE (expires_at IS NOT NULL AND expires_at < now())
      OR updated_at < now() - make_interval(days => GREATEST(p_session_days, 1));
  GET DIAGNOSTICS sessions = ROW_COUNT;
  DELETE FROM worker_heartbeats WHERE updated_at < now() - interval '7 days';
  GET DIAGNOSTICS heartbeats = ROW_COUNT;
  RETURN jsonb_build_object('sessions', sessions, 'heartbeats', heartbeats);
END;
$$ LANGUAGE plpgsql;
