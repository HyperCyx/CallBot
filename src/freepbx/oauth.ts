import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { metrics } from '../lib/metrics.js';
import { FreePBXError } from './types.js';
import { httpJson } from './http.js';

/**
 * OAuth 2.0 token manager for the FreePBX API.
 *
 * Documented facts used here (Sangoma "PBX GUI - API Authentication"):
 *   * "Authenticating with your PBX to utilize the API requires the use of
 *     oauth 2.0" and the PBX supports: authorization code, implicit,
 *     resource-owner-password, client credentials, and refresh token grants.
 *   * "To connect and utilize the API you will first need to create an
 *     'Application' in API Applications."
 *   * A machine-to-machine ("Client credentials grant") application is the
 *     documented fit for a backend service such as this one.
 *   * The concrete Token URL is shown in the PBX UI under
 *     API -> API URL List -> "OAuth 2.0 URLs -> Token". We do not invent it:
 *     FREEPBX_TOKEN_URL must be set from that page (env falls back to the
 *     conventional `<base>/admin/api/api/token`).
 *
 * The client secret, the access token and the refresh token never leave this
 * module: they are not logged, not returned to callers, and not stored in the
 * database.
 */

interface TokenResponse {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  error?: string;
  error_description?: string;
}

interface CachedToken {
  accessToken: string;
  /** epoch ms */
  expiresAt: number;
  scope?: string;
}

export class FreePBXAuth {
  private token: CachedToken | null = null;
  /** Coalesces concurrent refreshes so 50 parallel calls cause ONE token fetch. */
  private inflight: Promise<CachedToken> | null = null;

  constructor(
    private readonly cfg: {
      tokenUrl: string;
      clientId: string;
      clientSecret: string;
      scope: string;
      /** Resource owner credentials grant (optional, documented fallback). */
      username?: string;
      password?: string;
    } = {
      tokenUrl: env.freepbx.tokenUrl,
      clientId: env.freepbx.clientId,
      clientSecret: env.freepbx.clientSecret,
      scope: env.freepbx.scope,
    },
  ) {}

  /** Returns a valid access token, fetching/refreshing when needed. */
  async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.token && this.token.expiresAt - 30_000 > now) return this.token.accessToken;
    if (this.token?.expiresAt && this.token.expiresAt - 30_000 <= now && this.hasRefreshToken()) {
      // Refresh tokens are only issued by grants that support them. If we never
      // received one we simply re-run client_credentials, which is stateless.
    }
    if (this.inflight) return (await this.inflight).accessToken;
    this.inflight = this.fetchToken()
      .then((t) => {
        this.token = t;
        return t;
      })
      .finally(() => {
        this.inflight = null;
      });
    return (await this.inflight).accessToken;
  }

  private hasRefreshToken(): boolean {
    return Boolean(this.refreshToken);
  }

  private refreshToken: string | null = null;

  private async fetchToken(): Promise<CachedToken> {
    if (!this.cfg.tokenUrl || !this.cfg.clientId || !this.cfg.clientSecret) {
      throw new FreePBXError(
        'FreePBX OAuth is not configured (FREEPBX_TOKEN_URL / FREEPBX_CLIENT_ID / FREEPBX_CLIENT_SECRET)',
        'CONFIG',
      );
    }

    const form: Record<string, string> = {
      grant_type: this.refreshToken ? 'refresh_token' : 'client_credentials',
      client_id: this.cfg.clientId,
      client_secret: this.cfg.clientSecret,
    };
    if (this.refreshToken) form.refresh_token = this.refreshToken;
    if (this.cfg.scope) form.scope = this.cfg.scope;

    metrics.counters.oauthTokenFetches.inc(1, { grant: form.grant_type ?? 'unknown' });

    try {
      const res = await httpJson<TokenResponse>(this.cfg.tokenUrl, {
        method: 'POST',
        form,
        operation: 'oauth.token',
        // Auth endpoints are usually slower than data endpoints on small PBXs.
        timeoutMs: Math.max(env.freepbx.timeoutMs, 15_000),
      });

      const body = res.body ?? {};
      if (body.error || !body.access_token) {
        // Never log the body verbatim: it can echo credentials.
        throw new FreePBXError(
          `FreePBX OAuth rejected the token request: ${body.error ?? 'no access_token in response'}`,
          'AUTH',
          { httpStatus: res.status, errors: { error: body.error, description: body.error_description } },
        );
      }

      if (body.refresh_token) this.refreshToken = body.refresh_token;
      const expiresIn = Number(body.expires_in ?? 3600);
      logger.debug({ scope: body.scope, expiresIn }, 'obtained FreePBX access token');

      return {
        accessToken: body.access_token,
        expiresAt: Date.now() + Math.max(60, expiresIn) * 1000,
        scope: body.scope,
      };
    } catch (err) {
      metrics.counters.oauthFailures.inc(1);
      if (this.refreshToken) {
        // Refresh token may have expired/been revoked: fall back to
        // client_credentials on the next attempt instead of failing forever.
        logger.warn('FreePBX refresh_token grant failed; falling back to client_credentials');
        this.refreshToken = null;
      }
      throw err;
    }
  }

  /** Drops the cached token (called on a 401 so the next call re-authenticates). */
  invalidate(): void {
    this.token = null;
  }

  /** Diagnostic only: confirms credentials work without exposing the token. */
  async authenticate(): Promise<void> {
    await this.getAccessToken();
  }
}
