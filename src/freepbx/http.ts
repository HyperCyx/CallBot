import https from 'node:https';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { metrics } from '../lib/metrics.js';
import { FreePBXError } from './types.js';

/**
 * Tiny HTTPS JSON transport for the PBX API.
 *
 * Why not `fetch`? We need:
 *   * a custom CA bundle (PBX installs commonly use a self-signed or
 *     private-CA certificate) without disabling verification globally,
 *   * hard connect/response timeouts,
 *   * deterministic retry classification,
 *   * zero third-party dependencies in the credential-bearing path.
 */

let caBundle: Buffer | undefined;

function loadCa(): Buffer | undefined {
  if (caBundle !== undefined) return caBundle;
  if (env.freepbx.caFile) {
    try {
      caBundle = readFileSync(env.freepbx.caFile);
      logger.info({ caFile: env.freepbx.caFile }, 'loaded FreePBX CA bundle');
    } catch (err) {
      throw new FreePBXError(`Cannot read FREEPBX_CA_FILE: ${(err as Error).message}`, 'CONFIG');
    }
  } else {
    caBundle = undefined;
  }
  return caBundle;
}

const agents = new Map<string, https.Agent>();

function agentFor(target: URL): https.Agent {
  const key = `${target.origin}:${env.freepbx.tlsVerify}:${env.freepbx.caFile}`;
  const existing = agents.get(key);
  if (existing) return existing;
  const agent = new https.Agent({
    keepAlive: true,
    maxSockets: 8,
    // An explicit rejectUnauthorized:false is only ever produced by setting
    // FREEPBX_TLS_VERIFY=false, which env validation warns about loudly.
    rejectUnauthorized: env.freepbx.tlsVerify,
    ...(loadCa() ? { ca: loadCa() as Buffer } : {}),
  });
  agents.set(key, agent);
  return agent;
}

export interface HttpJsonOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  /** Internal identifier used in logs/metrics; never contains secrets. */
  operation?: string;
  /** Form-encoded body instead of JSON (OAuth token endpoint). */
  form?: Record<string, string>;
}

export interface HttpJsonResponse<T = unknown> {
  status: number;
  body: T;
  latencyMs: number;
}

/** Redacts anything that looks like a credential from a response body before logging. */
function redactForLog(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[deep]';
  if (typeof value === 'string') {
    if (/^(Bearer|Basic)\s/i.test(value)) return '[REDACTED]';
    if (value.length > 300) return `${value.slice(0, 300)}…`;
    return value;
  }
  if (Array.isArray(value)) return value.slice(0, 10).map((v) => redactForLog(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (/token|secret|password|passwd|authorization|client_id/i.test(k)) out[k] = '[REDACTED]';
      else out[k] = redactForLog(v, depth + 1);
    }
    return out;
  }
  return value;
}

export async function httpJson<T = unknown>(url: string, options: HttpJsonOptions = {}): Promise<HttpJsonResponse<T>> {
  const started = Date.now();
  const target = new URL(url);
  const isHttps = target.protocol === 'https:';
  const transport = isHttps ? https : http;
  const operation = options.operation ?? 'http';

  const headers: Record<string, string> = { accept: 'application/json', ...options.headers };
  let payload: string | undefined;
  if (options.form) {
    payload = new URLSearchParams(options.form).toString();
    headers['content-type'] = 'application/x-www-form-urlencoded';
    headers['content-length'] = String(Buffer.byteLength(payload));
  } else if (options.body !== undefined) {
    payload = JSON.stringify(options.body);
    headers['content-type'] = 'application/json';
    headers['content-length'] = String(Buffer.byteLength(payload));
  }

  const timeoutMs = options.timeoutMs ?? env.freepbx.timeoutMs;

  return await new Promise<HttpJsonResponse<T>>((resolve, reject) => {
    const req = transport.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (isHttps ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method: options.method ?? (payload ? 'POST' : 'GET'),
        headers,
        ...(isHttps ? { agent: agentFor(target) } : {}),
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const latencyMs = Date.now() - started;
          metrics.histograms.pbxLatencyMs.observe(latencyMs, { operation });
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed: unknown = undefined;
          if (text) {
            try {
              parsed = JSON.parse(text);
            } catch {
              parsed = { raw: text.slice(0, 500) };
            }
          }
          const status = res.statusCode ?? 0;
          if (status >= 400) {
            const err = new FreePBXError(`FreePBX ${operation} failed with HTTP ${status}`, status === 401 || status === 403 ? 'AUTH' : 'REJECTED', {
              httpStatus: status,
              errors: redactForLog(parsed),
              operation,
            });
            reject(err);
            return;
          }
          resolve({ status, body: parsed as T, latencyMs });
        });
      },
    );

    req.on('timeout', () => {
      req.destroy(new FreePBXError(`FreePBX ${operation} timed out after ${timeoutMs}ms`, 'TIMEOUT', { operation }));
    });
    req.on('error', (err) => {
      if (err instanceof FreePBXError) reject(err);
      else reject(new FreePBXError(`FreePBX ${operation} network error: ${err.message}`, 'NETWORK', { operation }));
    });

    if (payload) req.write(payload);
    req.end();
  });
}
