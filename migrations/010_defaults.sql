-- =============================================================================
-- 010 - dashboard views + default data
-- =============================================================================
-- Default data here is CONFIGURATION, not business logic: every row can be
-- edited from the Telegram admin panel afterwards (spec §22, §45).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Dashboard rollup (spec §24)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_admin_dashboard AS
SELECT
  (SELECT count(*) FROM users WHERE deleted_at IS NULL)                                   AS users_total,
  (SELECT count(*) FROM users WHERE status = 'ACTIVE' AND deleted_at IS NULL)              AS users_active,
  (SELECT count(*) FROM users WHERE status = 'PENDING' AND deleted_at IS NULL)             AS users_pending,
  (SELECT count(*) FROM users WHERE status = 'BLOCKED' AND deleted_at IS NULL)             AS users_blocked,
  (SELECT count(*) FROM users WHERE status = 'EXPIRED' AND deleted_at IS NULL)             AS users_expired,
  (SELECT count(*) FROM numbers WHERE deleted_at IS NULL)                                  AS numbers_total,
  (SELECT count(*) FROM numbers WHERE status = 'AVAILABLE' AND deleted_at IS NULL)         AS numbers_available,
  (SELECT count(*) FROM numbers WHERE status = 'RESERVED'  AND deleted_at IS NULL)         AS numbers_reserved,
  (SELECT count(*) FROM numbers WHERE status = 'ASSIGNED'  AND deleted_at IS NULL)         AS numbers_assigned,
  (SELECT count(*) FROM numbers WHERE status = 'SUSPENDED' AND deleted_at IS NULL)         AS numbers_suspended,
  (SELECT count(*) FROM numbers WHERE status = 'EXPIRED'   AND deleted_at IS NULL)         AS numbers_expired,
  (SELECT count(*) FROM call_sessions)                                                     AS live_calls,
  (SELECT count(*) FROM call_history WHERE calldate >= date_trunc('day', now() at time zone 'utc')) AS calls_today,
  (SELECT count(*) FROM users u WHERE u.deleted_at IS NULL
     AND EXISTS (SELECT 1 FROM plans p WHERE p.id = u.plan_id AND p.rank > 0))             AS premium_users,
  (SELECT COALESCE(sum(amount_cents),0) FROM referral_commissions WHERE status IN ('PENDING','APPROVED')) AS referral_pending_cents,
  (SELECT COALESCE(sum(amount_cents),0) FROM referral_commissions WHERE status = 'PAID')   AS referral_paid_cents,
  (SELECT count(*) FROM reconciliation_findings WHERE resolved_at IS NULL AND severity = 'CRITICAL') AS critical_findings,
  (SELECT count(*) FROM freepbx_sync_jobs WHERE status IN ('PENDING','FAILED'))             AS pending_pbx_jobs;

-- -----------------------------------------------------------------------------
-- Per-user inventory view (My Numbers)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_user_numbers AS
SELECT
  n.id            AS number_id,
  n.phone_number,
  n.status,
  n.plan_type,
  n.expiration_date,
  n.assigned_user_id,
  n.sip_extension,
  c.name          AS country_name,
  c.flag          AS country_flag,
  s.name          AS service_name,
  s.icon          AS service_icon,
  a.id            AS assignment_id,
  a.assigned_at,
  a.expires_at    AS assignment_expires_at,
  a.freepbx_route_id
FROM numbers n
JOIN countries c ON c.id = n.country_id
JOIN services  s ON s.id = n.service_id
LEFT JOIN number_assignments a
       ON a.number_id = n.id AND a.released_at IS NULL AND a.status IN ('ACTIVE','SUSPENDED')
WHERE n.deleted_at IS NULL;

-- -----------------------------------------------------------------------------
-- Roles (spec §27 RBAC)
-- -----------------------------------------------------------------------------
INSERT INTO roles (code, name, description, permissions, is_system) VALUES
  ('super_admin', 'Super Administrator',
   'Unrestricted. Cannot be removed from the allowlisted bootstrap admins.',
   '["*"]'::jsonb, true),
  ('admin', 'Administrator',
   'Full operational control: users, inventory, routing, plans, referrals.',
   '["users:*","numbers:*","services:*","countries:*","plans:*","referrals:*","calls:*","settings:*","audit:read","pbx:sync"]'::jsonb, true),
  ('support', 'Support Agent',
   'Read-only user/inventory access plus number suspend/release and call lookups.',
   '["users:read","numbers:read","numbers:suspend","numbers:release","calls:read","audit:read"]'::jsonb, true),
  ('user', 'End User',
   'Regular SIP user. Own data only.',
   '["self:read","self:numbers","self:calls","self:referral"]'::jsonb, true)
ON CONFLICT (code) DO NOTHING;

-- -----------------------------------------------------------------------------
-- Default settings (everything admin-editable from Telegram)
-- -----------------------------------------------------------------------------
INSERT INTO admin_settings (key, value, value_type, category, label, description) VALUES
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
ON CONFLICT (key) DO NOTHING;

-- -----------------------------------------------------------------------------
-- Default plans: FREE and PREMIUM (spec §22). Both fully editable afterwards.
-- -----------------------------------------------------------------------------
INSERT INTO plans (code, name, description, is_active, is_default, rank, max_numbers,
                   allows_premium_numbers, allows_test_number, price_cents_per_month,
                   currency, duration_days, features)
VALUES
  ('free', 'Free', 'Entry plan: 1 number, standard inventory.', true, true, 0, 1,
   false, true, 0, 'EUR', 30,
   '{"label":"🆓 Free","voice_quality":"standard","support":"community"}'::jsonb),
  ('premium', 'Premium', 'Up to 5 numbers, premium inventory, priority support.', true, false, 10, 5,
   true, true, 999, 'EUR', 30,
   '{"label":"💎 Premium","voice_quality":"high","support":"priority"}'::jsonb)
ON CONFLICT (code) DO NOTHING;
