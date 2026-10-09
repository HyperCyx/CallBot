import { query } from '../db/pool.js';
import { logger } from '../lib/logger.js';
import { FreePBXGraphQLClient } from './client.js';
import { env } from '../config/env.js';

/**
 * Version / capability compatibility layer (spec §41).
 *
 * "My environment may use FreePBX/Asterisk versions different from the
 *  documentation examples. Therefore: detect FreePBX version, detect Asterisk
 *  version, detect installed API module version, check available API schema,
 *  verify required scopes, verify each mutation/query before production use."
 *
 * How we satisfy each requirement HONESTLY:
 *
 *  - "Check available API schema": standard GraphQL introspection against the
 *    documented endpoint. This is the authoritative answer to "does this
 *    operation exist on THIS PBX", and it beats guessing from a version number.
 *  - "Detect versions": there is no documented GraphQL query that returns the
 *    FreePBX/Asterisk version, so we do not invent one. Asterisk's version is
 *    read from AMI (`core show version`) when AMI is enabled, and an operator
 *    can supply FREEPBX_VERSION_HINT. Anything unknown stays `null` - we never
 *    fabricate a version.
 *  - "Verify required scopes": the practical, reliable test is to execute a
 *    read operation; a scope problem surfaces as an OAuth/GraphQL permission
 *    error. The probe does exactly that and reports the missing capability with
 *    the operation name.
 */

export const REQUIRED_QUERIES = [
  'fetchExtension',
  'fetchAllExtensions',
  'fetchAllValidExtensions',
  'inboundRoute',
  'allInboundRoutes',
  'fetchAllCdrs',
  'fetchCdr',
] as const;

export const REQUIRED_MUTATIONS = [
  'addExtension',
  'updateExtension',
  'deleteExtension',
  'addInboundRoute',
  'updateInboundRoute',
  'removeInboundRoute',
] as const;

/** Operations the spec asked for that are NOT in the official documentation. */
export const UNSUPPORTED_BY_DESIGN = [
  {
    requested: 'live/active call listing',
    reason:
      'Not confirmed in the official API documentation. CDR is written after a call completes and cannot represent live calls. Implemented via Asterisk AMI instead.',
  },
  {
    requested: 'carrier/DID provisioning (buying numbers)',
    reason: 'Not confirmed in the official API documentation. The PBX API manages the PBX, not upstream carrier inventory. Numbers are imported (CSV/single/bulk) or supplied by an external provider adapter.',
  },
  {
    requested: 'REST equivalents for extensions/routes',
    reason: 'The Core and CDR modules document GraphQL operations. We use those; no REST endpoints are invented.',
  },
] as const;

export interface CompatibilityReport {
  mode: 'graphql' | 'mock';
  pbxVersion: string | null;
  asteriskVersion: string | null;
  apiModuleVersion: string | null;
  schemaOk: boolean;
  supported: string[];
  missing: string[];
  notes: string[];
}

export async function runCompatibilityProbe(client: FreePBXGraphQLClient): Promise<CompatibilityReport> {
  const notes: string[] = [];
  let supported: string[] = [];
  let missing: string[] = [];
  let schemaOk = false;

  const version = await client.detectVersion();

  try {
    const { queries, mutations } = await client.introspect();
    const wanted: string[] = [...REQUIRED_QUERIES, ...REQUIRED_MUTATIONS];
    supported = wanted.filter((op) => queries.includes(op) || mutations.includes(op));
    missing = wanted.filter((op) => !queries.includes(op) && !mutations.includes(op));
    schemaOk = missing.length === 0;
    if (!schemaOk) {
      notes.push(
        `Missing operations on this PBX: ${missing.join(', ')}. ` +
          `Either the module providing them is not installed/licensed, or this build names them differently. ` +
          `The application degrades gracefully: features that depend on a missing operation are disabled and reported in the admin panel.`,
      );
    }
    logger.info({ supported: supported.length, missing: missing.length }, 'FreePBX API compatibility probe finished');
  } catch (err) {
    notes.push(
      `Schema introspection failed (${(err as Error).message}). This usually means the API application lacks the required scope, ` +
        `or the GraphQL endpoint is not enabled. Verify the Application type and the scope in the PBX API Scope Visualizer.`,
    );
    logger.error({ err: (err as Error).message }, 'FreePBX compatibility probe failed');
  }

  // Asterisk version via AMI, when available. Reuses the SHARED, singleton
  // live-call connection - a second ad-hoc client would double the login
  // attempts (and double the fail2ban pressure) against the PBX.
  let asteriskVersion = version.asteriskVersion;
  if (!asteriskVersion && env.ami.enabled) {
    try {
      const { getLiveCallSource } = await import('./index.js');
      const source = getLiveCallSource();
      if (source.kind === 'ami' && source.coreShowVersion) {
        const out = await source.coreShowVersion();
        const m = out?.match(/Asterisk\s+([\d.]+\S*)/i);
        if (m?.[1]) asteriskVersion = m[1];
      }
    } catch (err) {
      notes.push(`AMI version query failed: ${(err as Error).message}`);
    }
  }

  const report: CompatibilityReport = {
    mode: client.kind,
    pbxVersion: version.pbxVersion,
    asteriskVersion,
    apiModuleVersion: version.apiModuleVersion,
    schemaOk,
    supported,
    missing,
    notes,
  };

  await query(
    `INSERT INTO freepbx_compat (id, pbx_version, asterisk_version, api_module_version, gql_schema_ok,
                                 supported_operations, missing_operations, detected_scope, detected_at, notes)
     VALUES ('current', $1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, now(), $8)
     ON CONFLICT (id) DO UPDATE SET
       pbx_version = EXCLUDED.pbx_version,
       asterisk_version = EXCLUDED.asterisk_version,
       api_module_version = EXCLUDED.api_module_version,
       gql_schema_ok = EXCLUDED.gql_schema_ok,
       supported_operations = EXCLUDED.supported_operations,
       missing_operations = EXCLUDED.missing_operations,
       detected_scope = EXCLUDED.detected_scope,
       detected_at = EXCLUDED.detected_at,
       notes = EXCLUDED.notes`,
    [
      report.pbxVersion,
      report.asteriskVersion,
      report.apiModuleVersion,
      report.schemaOk,
      JSON.stringify(report.supported),
      JSON.stringify(report.missing),
      env.freepbx.scope || null,
      report.notes.join('\n'),
    ],
  );

  return report;
}

export async function getStoredCompatibilityReport(): Promise<Record<string, unknown> | null> {
  const res = await query<{
    pbx_version: string | null;
    asterisk_version: string | null;
    api_module_version: string | null;
    gql_schema_ok: boolean | null;
    missing_operations: unknown;
    detected_at: Date | null;
    notes: string | null;
  }>('SELECT pbx_version, asterisk_version, api_module_version, gql_schema_ok, missing_operations, detected_at, notes FROM freepbx_compat WHERE id = $1', [
    'current',
  ]);
  const row = res.rows[0];
  if (!row) return null;
  return {
    pbxVersion: row.pbx_version,
    asteriskVersion: row.asterisk_version,
    apiModuleVersion: row.api_module_version,
    schemaOk: row.gql_schema_ok,
    missing: row.missing_operations,
    detectedAt: row.detected_at,
    notes: row.notes,
  };
}
