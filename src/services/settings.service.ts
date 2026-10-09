import { many, one, query } from '../db/pool.js';
import { logger } from '../lib/logger.js';

/**
 * Admin settings service (spec §22, §23, §45).
 *
 * Every business rule that an administrator can tune lives in
 * `admin_settings` and is read through here. Nothing is hard-coded in the
 * handlers, so the same build behaves differently per deployment without a
 * redeploy.
 */

export interface SettingRow {
  key: string;
  value: unknown;
  value_type: 'string' | 'number' | 'boolean' | 'json' | 'secret_ref';
  category: string;
  label: string;
  description: string | null;
  is_editable: boolean;
}

interface CacheEntry {
  value: unknown;
  loadedAt: number;
}

const TTL_MS = 15_000;
const cache = new Map<string, CacheEntry>();

export async function getAllSettings(): Promise<SettingRow[]> {
  return many<SettingRow>(
    `SELECT key, value, value_type, category, label, description, is_editable
       FROM admin_settings ORDER BY category, key`,
  );
}

export async function getSettingRow(key: string): Promise<SettingRow | null> {
  return one<SettingRow>(
    `SELECT key, value, value_type, category, label, description, is_editable FROM admin_settings WHERE key = $1`,
    [key],
  );
}

/** Raw (untyped) fetch with a short-lived cache to keep menu rendering cheap. */
export async function getRaw(key: string, fallback?: unknown): Promise<unknown> {
  const cached = cache.get(key);
  if (cached && Date.now() - cached.loadedAt < TTL_MS) return cached.value;
  const row = await getSettingRow(key);
  const value = row ? row.value : fallback;
  cache.set(key, { value, loadedAt: Date.now() });
  return value;
}

export function clearSettingsCache(): void {
  cache.clear();
}

// --- typed getters (each has a safe fallback so a missing row never crashes the bot) ---

export async function getBool(key: string, fallback = false): Promise<boolean> {
  const v = await getRaw(key, fallback);
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return ['true', '1', 'yes', 'on'].includes(v.toLowerCase());
  return Boolean(v);
}

export async function getNumber(key: string, fallback = 0): Promise<number> {
  const v = await getRaw(key, fallback);
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export async function getString(key: string, fallback = ''): Promise<string> {
  const v = await getRaw(key, fallback);
  if (v === null || v === undefined) return fallback;
  return typeof v === 'string' ? v : JSON.stringify(v);
}

export async function setSetting(key: string, value: unknown, actorId?: string): Promise<void> {
  const row = await getSettingRow(key);
  if (!row) throw new Error(`Unknown setting: ${key}`);
  if (!row.is_editable) throw new Error(`Setting ${key} is not editable`);

  await query(
    `UPDATE admin_settings SET value = $2::jsonb, updated_by = $3 WHERE key = $1`,
    [key, JSON.stringify(value), actorId ?? null],
  );
  clearSettingsCache();
  logger.info({ key }, 'admin setting updated');
}

export interface ReferralConfig {
  enabled: boolean;
  commissionType: 'FIXED' | 'PERCENTAGE';
  commissionValue: number;
  currency: string;
  qualificationRule: 'SIGNUP' | 'USER_APPROVED' | 'FIRST_NUMBER_ASSIGNED' | 'PLAN_PURCHASED';
  maxPerReferrerPerDay: number;
  holdHours: number;
}

export async function getReferralConfig(): Promise<ReferralConfig> {
  const [enabled, type, value, currency, rule, cap, hold] = await Promise.all([
    getBool('referral.enabled', true),
    getString('referral.commission_type', 'PERCENTAGE'),
    getNumber('referral.commission_value', 10),
    getString('referral.currency', 'EUR'),
    getString('referral.qualification_rule', 'FIRST_NUMBER_ASSIGNED'),
    getNumber('referral.max_per_referrer_per_day', 20),
    getNumber('referral.hold_hours', 72),
  ]);
  return {
    enabled,
    commissionType: (type === 'FIXED' ? 'FIXED' : 'PERCENTAGE') as 'FIXED' | 'PERCENTAGE',
    commissionValue: value,
    currency,
    qualificationRule: rule as ReferralConfig['qualificationRule'],
    maxPerReferrerPerDay: cap,
    holdHours: hold,
  };
}
