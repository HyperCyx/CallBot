-- 017: USD is the platform currency (operator decision 2026-10-08).
-- Only DEFAULTs change; existing rows keep their stored currency because a
-- price's currency is part of its meaning (a EUR 100 plan is not a USD 100
-- plan) -- the operator edits amounts explicitly if ever needed.

ALTER TABLE plans               ALTER COLUMN currency SET DEFAULT 'USD';
ALTER TABLE service_countries   ALTER COLUMN currency SET DEFAULT 'USD';
ALTER TABLE numbers             ALTER COLUMN currency SET DEFAULT 'USD';
ALTER TABLE referral_commissions ALTER COLUMN currency SET DEFAULT 'USD';
