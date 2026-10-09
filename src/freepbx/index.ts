import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { FreePBXGraphQLClient } from './client.js';
import { MockFreePBXClient } from './mock.js';
import { AmiClient, DisabledLiveCallSource } from './ami.js';
import type { FreePBXBackend, LiveCallSource } from './types.js';

/**
 * Backend selection.
 *
 * `FREEPBX_MODE=mock` gives a fully functional PBX double so the platform can
 * be developed, demoed and integration-tested without touching a real PBX.
 * `FREEPBX_MODE=graphql` uses the documented PBX GUI GraphQL API.
 *
 * Callers depend on the `FreePBXBackend` interface only, never on the concrete
 * class, which is what keeps FreePBX code out of the Telegram handlers
 * (spec §30).
 */

let backend: FreePBXBackend | null = null;

export function getFreePBX(): FreePBXBackend {
  if (backend) return backend;
  if (env.freepbx.mode === 'mock') {
    logger.warn('FreePBX is running in MOCK mode - no real PBX calls will be made');
    backend = new MockFreePBXClient();
  } else {
    backend = new FreePBXGraphQLClient();
  }
  return backend;
}

/** Test seam: inject a specific backend (used by vitest). */
export function setFreePBX(instance: FreePBXBackend | null): void {
  backend = instance;
}

export function isMockMode(): boolean {
  return env.freepbx.mode === 'mock';
}

export { MockFreePBXClient } from './mock.js';
export { FreePBXGraphQLClient } from './client.js';
export { FreePBXAuth } from './oauth.js';
export { runCompatibilityProbe, getStoredCompatibilityReport, UNSUPPORTED_BY_DESIGN } from './compat.js';
export type { FreePBXBackend, LiveCallSource } from './types.js';

// ---------------------------------------------------------------------------
// Live call source (AMI)
// ---------------------------------------------------------------------------

let liveSource: LiveCallSource | null = null;

export function getLiveCallSource(): LiveCallSource {
  if (liveSource) return liveSource;
  liveSource = env.ami.enabled ? new AmiClient() : new DisabledLiveCallSource();
  return liveSource;
}

export function setLiveCallSource(source: LiveCallSource | null): void {
  liveSource = source;
}
