import { env } from '../config/env.js';
import { logger, maskNumber } from '../lib/logger.js';
import { metrics } from '../lib/metrics.js';
import { generateSipPassword } from '../lib/crypto.js';
import { sleep } from '../lib/time.js';
import { FreePBXAuth } from './oauth.js';
import { httpJson } from './http.js';
import {
  FreePBXError,
  type CdrPage,
  type CdrQuery,
  type CdrRecord,
  type CreateExtensionInput,
  type FreePBXBackend,
  type FreePBXExtension,
  type FreePBXInboundRoute,
  type FreePBXResult,
  type FreePBXTech,
  type InboundRouteInput,
  type PbxVersionInfo,
  type UpdateExtensionInput,
  type UpdateInboundRouteInput,
} from './types.js';

/**
 * Live FreePBX backend (GraphQL PBX GUI API).
 *
 * IMPORTANT IMPLEMENTATION NOTES (all traceable to the official wiki):
 *
 * 1. Endpoint: POST <GRAPHQL_URL> (default `/admin/api/api/gql`) with
 *    `Authorization: Bearer <token>`.
 * 2. Every operation used below is documented. Where the spec asked for a name
 *    that the documentation does NOT use, the documented name wins and the
 *    difference is recorded in docs/05-freepbx-api-mapping.md:
 *       spec "fetchAllInboundRoutes"  -> documented query `allInboundRoutes`
 *       spec "fetchInboundRoute"      -> documented query `inboundRoute(id:)`
 *       spec "fetchAllExtensions"     -> documented query `fetchAllExtensions` ✓
 *       spec "fetchExtension"         -> documented query `fetchExtension(extensionId:)`
 *       spec "fetchAllCdrs"/"fetchCdr"-> documented queries, same names ✓
 *       spec "addInboundRoute"        -> documented mutation ✓
 * 3. An inbound route's identity is the composite string `<extension>/<cidnum>`
 *    (documented example: id "71667/1232"). It is required for update/remove,
 *    which is why we persist freepbx_route_id in the database.
 * 4. `addExtension` has no SIP-password field in the documented schema. The
 *    documented `updateExtension` DOES accept `extPassword`, so a new extension
 *    is created then immediately given its secret. If the PBX auto-generated a
 *    secret instead (older builds), the value returned by `fetchExtension`
 *    (`user.password` / `user.extPassword`) is used as the fallback and the
 *    user is told that the password is the PBX-generated one.
 * 5. Retry policy: reads retry freely; MUTATIONS are only retried when the
 *    failure provably happened before the request was accepted by the PBX
 *    (connection refused / DNS failure). A timeout on a mutation is NOT
 *    auto-retried, because the operation may well have succeeded - instead the
 *    caller records a sync job and the reconciler verifies reality. This is the
 *    difference between "eventually consistent" and "duplicated DIDs".
 */

/**
 * Schema drift handling.
 *
 * A PBX build can expose a slightly different schema than the documented one -
 * on the deployment this was tested against, `coreDevice` has no `callerId` and
 * no `sipdriver`, so the whole `fetchExtension` query was rejected with
 * `Cannot query field "callerId" on type "coredevice"`.
 *
 * The rule this project works under is "never invent a field", so the client
 * does the opposite of guessing: it asks the PBX, and when the PBX names a
 * documented field it does not have, that field is dropped from the query, the
 * deviation is logged once and remembered for the life of the process. The
 * operation still runs, with everything the deployment *does* support.
 */
export interface UnsupportedField {
  /** Type name exactly as the PBX reported it (e.g. `coredevice`). */
  typeName: string;
  /** Field name exactly as the PBX reported it (e.g. `callerId`). */
  field: string;
}

/**
 * Coerces a value to the scalar the live schema declares. The wiki's
 * `maxContacts: 2` is a *String* on some builds, and GraphQL rejects the whole
 * mutation over one wrong scalar type - so we follow the deployment.
 */
export function coerceScalar(value: unknown, scalar: string): unknown {
  const kind = scalar.replace(/[!\[\]]/g, '');
  if (kind === 'Int' || kind === 'Float') {
    if (typeof value === 'number') return value;
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
    return value;
  }
  if (kind === 'Boolean') {
    if (typeof value === 'boolean') return value;
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  }
  if (kind === 'String' || kind === 'ID') {
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return value;
  }
  return value;
}

/** Pulls `Cannot query field "x" on type "y"` out of a GraphQL error response. */
export function extractUnsupportedFields(errors: unknown[]): UnsupportedField[] {
  const out: UnsupportedField[] = [];
  for (const error of errors) {
    const message = typeof (error as { message?: unknown })?.message === 'string' ? (error as { message: string }).message : '';
    const match = message.match(/Cannot query field "([A-Za-z0-9_]+)" on type "([A-Za-z0-9_]+)"/);
    if (match?.[1] && match[2]) out.push({ field: match[1], typeName: match[2] });
  }
  return out;
}

/**
 * Removes selection fields from a query by name - `coreDevice { deviceId callerId }`
 * becomes `coreDevice { deviceId }`. Argument usages (`callerId: $cid`) are left
 * alone, and a selection set that would be left empty is removed together with
 * its parent field, because `{ }` is not valid GraphQL.
 */
export function stripFields(query: string, fields: string[]): { query: string; stripped: string[] } {
  let out = query;
  const stripped: string[] = [];
  for (const field of fields) {
    const re = new RegExp(`(?<![A-Za-z0-9_])${field}(?![A-Za-z0-9_:])`, 'g');
    if (!re.test(out)) continue;
    out = out.replace(re, '');
    stripped.push(field);
  }
  if (stripped.length === 0) return { query, stripped };
  // `parent { }` is invalid GraphQL: drop a parent whose selection became empty.
  out = out.replace(/(?<![A-Za-z0-9_])[A-Za-z0-9_]+\s*\{\s*\}/g, '');
  // Tidy the whitespace left behind so the logged query stays readable.
  return { query: out.replace(/[ 	]{2,}/g, ' ').replace(/\{\s+/g, '{ ').replace(/\s+\}/g, ' }'), stripped };
}

const READS = new Set(['fetchExtension', 'fetchAllExtensions', 'inboundRoute', 'allInboundRoutes', 'fetchAllCdrs', 'fetchCdr', 'fetchAllAdvanceSettings']);

function isSafeToRetryMutation(err: unknown): boolean {
  if (!(err instanceof FreePBXError)) return false;
  if (err.kind !== 'NETWORK') return false;
  return /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH/i.test(err.message);
}

export class FreePBXGraphQLClient implements FreePBXBackend {
  readonly kind = 'graphql' as const;
  private auth: FreePBXAuth;
  private readonly endpoint: string;

  constructor(private readonly opts: { graphqlUrl?: string; auth?: FreePBXAuth } = {}) {
    this.endpoint = opts.graphqlUrl ?? env.freepbx.graphqlUrl;
    this.auth = opts.auth ?? new FreePBXAuth();
  }

  // ---------------------------------------------------------------------------
  // Transport
  // ---------------------------------------------------------------------------

  private async execute<T>(
    query: string,
    variables: Record<string, unknown> | undefined,
    operation: string,
  ): Promise<T> {
    const isRead = READS.has(operation) || /^\s*query\b/.test(query);
    const maxAttempts = isRead ? Math.max(1, env.freepbx.maxRetries + 1) : 2;
    let lastErr: unknown;
    // Rewritten when this PBX build turns out not to expose a documented field
    // (see `unsupportedFields` / `stripFields` above).
    const known = [...this.unsupportedFields].map((k) => k.split('.').pop()!).filter(Boolean);
    let activeQuery = known.length > 0 ? stripFields(query, known).query : query;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const token = await this.auth.getAccessToken();
        metrics.counters.pbxRequests.inc(1, { operation });
        const res = await httpJson<{ data?: T; errors?: unknown[] }>(this.endpoint, {
          method: 'POST',
          operation,
          headers: { authorization: `Bearer ${token}` },
          body: { query: activeQuery, variables },
        });

        const body = res.body;
        if (body?.errors && body.errors.length > 0) {
          // A build can have a slightly different schema than the documented
          // one. If the PBX tells us which *field* it does not have, drop that
          // field and retry once per field instead of failing the operation:
          // the documented fields we can have are used, the ones this build
          // lacks are reported and skipped. (Never the other way round: we do
          // not invent fields to make a query fit.)
          const unsupported = extractUnsupportedFields(body.errors);
          if (unsupported.length > 0 && attempt < maxAttempts) {
            const { query: rewritten, stripped } = stripFields(activeQuery, unsupported.map((u) => u.field));
            if (stripped.length > 0) {
              for (const drift of unsupported) {
                if (!stripped.includes(drift.field)) continue;
                this.unsupportedFields.add(`${drift.typeName}.${drift.field}`);
                logger.warn(
                  { operation, type: drift.typeName, field: drift.field },
                  'this PBX build does not expose that field; it was dropped from the query (nothing else changed)',
                );
              }
              activeQuery = rewritten;
              continue;
            }
          }

          // GraphQL-level error (bad input, permission, unknown field...)
          throw new FreePBXError(`FreePBX ${operation} returned GraphQL errors`, 'GRAPHQL', {
            httpStatus: res.status,
            errors: body.errors,
            operation,
          });
        }
        if (!body?.data) {
          throw new FreePBXError(`FreePBX ${operation} returned an empty payload`, 'GRAPHQL', { operation });
        }
        return body.data;
      } catch (err) {
        lastErr = err;
        metrics.counters.pbxErrors.inc(1, {
          operation,
          kind: err instanceof FreePBXError ? err.kind : 'UNKNOWN',
        });

        if (err instanceof FreePBXError && err.kind === 'AUTH' && attempt === 1) {
          // Token may have been revoked / PBX restarted: re-authenticate once.
          this.auth.invalidate();
          metrics.counters.pbxRetries.inc(1, { operation, reason: 'auth' });
          continue;
        }

        const retryable = isRead ? err instanceof FreePBXError && err.retryable : isSafeToRetryMutation(err);
        if (!retryable || attempt === maxAttempts) throw err;

        const backoff = Math.min(4_000, 250 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 100);
        metrics.counters.pbxRetries.inc(1, { operation, reason: 'transient' });
        logger.warn({ operation, attempt, backoff }, 'retrying FreePBX request');
        await sleep(backoff);
      }
    }
    throw lastErr ?? new FreePBXError(`FreePBX ${operation} failed`, 'NETWORK', { operation });
  }

  /** Documented fields this deployment proved it does not have (`Type.field`). */
  private readonly unsupportedFields = new Set<string>();

  /** What this PBX turned out not to support, for the admin panel / probe. */
  schemaDeviations(): string[] {
    return [...this.unsupportedFields].sort();
  }

  /**
   * Live-schema helpers for mutations.
   *
   * The wiki documents `AddExtensionInput` with `outboundCID`, `emergencyCID`
   * and an integer `maxContacts`. The deployment this was verified against
   * exposes the same input as `addExtensionInput` with `outboundCid` /
   * `emergencyCid`, and `maxContacts` is a **String**. Sending either the
   * documented spelling or an integer therefore fails - so the client asks the
   * PBX what it actually has:
   *
   *   * the input **type name** comes from the mutation signature;
   *   * each key we want to send is matched **case-insensitively** against the
   *     PBX's own field names, and the PBX's spelling wins (nothing is
   *     invented: only a name the schema reports is ever used);
   *   * values are coerced to the declared scalar (Int/Float <-> String);
   *   * a key the schema does not have at all is dropped with a warning.
   */
  private readonly inputTypeCache = new Map<string, string | null>();
  private readonly inputFieldCache = new Map<string, Map<string, string>>();
  private readonly droppedInputKeys = new Set<string>();

  private async mutationInputType(field: string): Promise<string | null> {
    const cached = this.inputTypeCache.get(field);
    if (cached !== undefined) return cached;
    let found: string | null = null;
    try {
      const data = await this.execute<{
        __type?: { fields?: Array<{ name: string; args?: Array<{ name: string; type?: unknown }> }> | null } | null;
      }>(
        'query { __type(name: "Mutation") { fields { name args { name type { kind name ofType { kind name } } } } } }',
        undefined,
        'introspection',
      );
      const entry = data.__type?.fields?.find((f) => f.name === field);
      const argType = entry?.args?.find((a) => a.name === 'input')?.type as
        | { kind?: string; name?: string | null; ofType?: { kind?: string; name?: string | null } }
        | undefined;
      found = argType?.name ?? argType?.ofType?.name ?? null;
    } catch {
      found = null;
    }
    this.inputTypeCache.set(field, found);
    return found;
  }

  private async inputFieldTypes(typeName: string): Promise<Map<string, string>> {
    const cached = this.inputFieldCache.get(typeName);
    if (cached) return cached;
    const map = new Map<string, string>();
    try {
      const data = await this.execute<{
        __type?: {
          inputFields?: Array<{
            name: string;
            type?: { kind?: string; name?: string | null; ofType?: { kind?: string; name?: string | null } };
          }> | null;
        } | null;
      }>(
        `query { __type(name: ${JSON.stringify(typeName)}) { inputFields { name type { kind name ofType { kind name } } } } }`,
        undefined,
        'introspection',
      );
      for (const field of data.__type?.inputFields ?? []) {
        const scalar = field.type?.name ?? field.type?.ofType?.name ?? field.type?.kind ?? 'String';
        map.set(field.name, scalar);
      }
    } catch {
      /* introspection unavailable: the caller sends the keys as they are */
    }
    this.inputFieldCache.set(typeName, map);
    return map;
  }

  /** Rewrites an input object into the shape and types this PBX actually has. */
  private async prepareInput(field: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const typeName = await this.mutationInputType(field);
    if (!typeName) return input;
    const fields = await this.inputFieldTypes(typeName);
    if (fields.size === 0) return input;

    const byLower = new Map([...fields.keys()].map((name) => [name.toLowerCase(), name]));
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
      if (value === undefined || value === null) continue;
      // The PBX's own spelling wins: `outboundCID` (documented) is `outboundCid` here.
      const resolved = fields.has(key) ? key : byLower.get(key.toLowerCase());
      if (!resolved) {
        if (!this.droppedInputKeys.has(`${typeName}.${key}`)) {
          this.droppedInputKeys.add(`${typeName}.${key}`);
          logger.warn({ field, input: typeName, key }, 'this PBX build has no such input field; it was not sent');
        }
        continue;
      }
      const scalar = fields.get(resolved) ?? 'String';
      out[resolved] = coerceScalar(value, scalar);
    }
    return out;
  }

  private async mutate<T>(
    operation: string,
    field: string,
    input: Record<string, unknown>,
    selection: string,
  ): Promise<T> {
    // The declared variable type must be the one the PBX has (`addExtensionInput`),
    // not the documented TypeScript-style name (`AddExtensionInput`).
    const declared = (await this.mutationInputType(field)) ?? `${operation}Input`;
    const query = `mutation ${field}($input: ${declared}!) { ${field}(input: $input) { ${selection} } }`;
    const data = await this.execute<Record<string, T>>(query, { input }, field);
    const result = data[field];
    if (!result) throw new FreePBXError(`FreePBX ${field} returned no result`, 'GRAPHQL', { operation: field });
    return result;
  }

  /**
   * Some PBX builds type mutation inputs loosely and reject unknown variables.
   * When that happens we inline the arguments instead of failing the whole
   * operation (documented inputs only; no invented fields).
   */
  private async mutateInline<T>(field: string, input: Record<string, unknown>, selection: string): Promise<T> {
    const args = Object.entries(input)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
      .join(', ');
    const query = `mutation { ${field}(input: { ${args} }) { ${selection} } }`;
    const data = await this.execute<Record<string, T>>(query, undefined, field);
    const result = data[field];
    if (!result) throw new FreePBXError(`FreePBX ${field} returned no result`, 'GRAPHQL', { operation: field });
    return result;
  }

  private async mutateWithFallback<T>(
    operationName: string,
    field: string,
    input: Record<string, unknown>,
    selection: string,
  ): Promise<T> {
    const prepared = await this.prepareInput(field, input);
    try {
      return await this.mutate<T>(operationName, field, prepared, selection);
    } catch (err) {
      const isVariableShapeProblem =
        err instanceof FreePBXError &&
        err.kind === 'GRAPHQL' &&
        JSON.stringify(err.detail?.errors ?? '').match(/type|Unknown argument|variable/i) !== null;
      if (!isVariableShapeProblem) throw err;
      logger.warn({ field }, 'PBX rejected typed variables; retrying with inline arguments');
      return this.mutateInline<T>(field, prepared, selection);
    }
  }

  // ---------------------------------------------------------------------------
  // Auth / diagnostics
  // ---------------------------------------------------------------------------

  async authenticate(): Promise<void> {
    await this.auth.authenticate();
  }

  async ping(): Promise<{ ok: boolean; detail?: string }> {
    try {
      const data = await this.execute<{ fetchAllValidExtensions?: { status?: boolean; count?: number } }>(
        'query { fetchAllValidExtensions { status message count } }',
        undefined,
        'fetchAllValidExtensions',
      );
      return { ok: data.fetchAllValidExtensions?.status !== false, detail: `extensions=${data.fetchAllValidExtensions?.count ?? '?'}` };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  async detectVersion(): Promise<PbxVersionInfo> {
    /**
     * There is no documented GraphQL operation returning the PBX/Asterisk
     * version, so we do not invent one. Instead:
     *  - operation availability is verified with standard GraphQL introspection
     *    (implemented in compat.ts), which is strictly more useful, and
     *  - the human-readable versions are taken from AMI `core show version`
     *    when AMI is enabled (see ami.ts), or from the FREEPBX_VERSION_HINT
     *    environment variable if an operator supplies it.
     */
    return {
      pbxVersion: process.env.FREEPBX_VERSION_HINT ?? null,
      asteriskVersion: null,
      apiModuleVersion: null,
    };
  }

  /** Standard GraphQL introspection - used by the compatibility probe (§41). */
  async introspect(): Promise<{ queries: string[]; mutations: string[] }> {
    const query = `query Introspect { __schema {
      queryType { fields { name } }
      mutationType { fields { name } }
    } }`;
    type IntrospectShape = {
      __schema: {
        queryType?: { fields?: Array<{ name: string }> } | null;
        mutationType?: { fields?: Array<{ name: string }> } | null;
      };
    };
    const data = await this.execute<IntrospectShape>(query, undefined, 'introspection');
    const s = data.__schema;
    return {
      queries: (s.queryType?.fields ?? []).map((f) => f.name).sort(),
      mutations: (s.mutationType?.fields ?? []).map((f) => f.name).sort(),
    };
  }

  // ---------------------------------------------------------------------------
  // Extensions (documented: Core module GraphQL API)
  // ---------------------------------------------------------------------------

  async createExtension(
    input: CreateExtensionInput,
    opts: { sipPassword?: string } = {},
  ): Promise<FreePBXResult & { extensionId: string; sipPassword?: string }> {
    const sipPassword = opts.sipPassword ?? generateSipPassword();

    // 1. Documented addExtension. Note: `email` is marked Mandatory in the docs.
    const created = await this.mutateWithFallback<FreePBXResult>(
      'AddExtensionInput',
      'addExtension',
      {
        extensionId: input.extensionId,
        name: input.name,
        tech: input.tech ?? 'pjsip',
        email: input.email,
        callerID: input.callerId,
        outboundCID: input.outboundCid,
        emergencyCID: input.emergencyCid,
        vmEnable: input.vmEnable ?? false,
        vmPassword: input.vmPassword,
        /*
         * `umEnable` is deliberately NOT sent unless the caller asks for it.
         * Verified against the live PBX: passing `umEnable: false` makes every
         * later `updateExtension` answer `{status: null}` (so the SIP secret is
         * never applied), while omitting the key works. `umEnable: true` is
         * rejected unless `umPassword` is supplied. A pure SIP user therefore
         * keeps whatever default the PBX applies to `addExtension`.
         */
        ...(input.umEnable === true ? { umEnable: true, umPassword: input.umPassword } : {}),
        maxContacts: input.maxContacts ?? 2,
        clientMutationId: input.clientMutationId,
      },
      'status message',
    );

    if (!created.status) {
      throw new FreePBXError(`FreePBX rejected addExtension: ${created.message}`, 'REJECTED', { operation: 'addExtension' });
    }

    // 2. Documented updateExtension with extPassword sets the SIP secret.
    try {
      const updated = await this.mutateWithFallback<FreePBXResult>(
        'UpdateExtensionInput',
        'updateExtension',
        { extensionId: input.extensionId, name: input.name, tech: input.tech ?? 'pjsip', extPassword: sipPassword },
        'status message',
      );
      if (updated.status) {
        // Confirm the secret really changed on the PBX before telling the user
        // anything - a status of `true` alone is not proof (see umEnable note).
        const verify = await this.getExtension(input.extensionId).catch(() => null);
        const applied = verify?.user?.extPassword || verify?.user?.password || undefined;
        if (applied && applied !== sipPassword) {
          logger.warn({ extension: input.extensionId }, 'PBX kept its own SIP secret; reporting the PBX-generated one');
          return { status: true, message: 'Extension created; SIP secret is PBX-generated', extensionId: input.extensionId, sipPassword: applied };
        }
        logger.info({ extension: input.extensionId }, 'FreePBX extension created with explicit SIP secret');
        return { status: true, message: created.message, extensionId: input.extensionId, sipPassword };
      }
      logger.warn({ extension: input.extensionId, message: updated.message }, 'updateExtension(extPassword) returned status=false');
    } catch (err) {
      // Non-fatal: the extension exists. We fall back to reading back whatever
      // secret the PBX generated and report that to the user instead of lying.
      logger.warn({ extension: input.extensionId, err: (err as Error).message }, 'could not set SIP secret via updateExtension');
    }

    const fetched = await this.getExtension(input.extensionId);
    const pbxSecret = fetched?.user?.password || fetched?.user?.extPassword || undefined;
    return {
      status: true,
      message: 'Extension created; SIP secret is PBX-generated',
      extensionId: input.extensionId,
      ...(pbxSecret ? { sipPassword: pbxSecret } : {}),
    };
  }

  async updateExtension(input: UpdateExtensionInput): Promise<FreePBXResult & { extensionId: string }> {
    const res = await this.mutateWithFallback<FreePBXResult>(
      'UpdateExtensionInput',
      'updateExtension',
      { ...input },
      'status message clientMutationId',
    );
    if (!res.status) throw new FreePBXError(`FreePBX rejected updateExtension: ${res.message}`, 'REJECTED', { operation: 'updateExtension' });
    return { ...res, extensionId: input.extensionId };
  }

  async deleteExtension(extensionId: string): Promise<FreePBXResult> {
    const res = await this.mutateWithFallback<FreePBXResult>(
      'DeleteExtensionInput',
      'deleteExtension',
      { extensionId },
      'status message',
    );
    if (!res.status) throw new FreePBXError(`FreePBX rejected deleteExtension: ${res.message}`, 'REJECTED', { operation: 'deleteExtension' });
    return res;
  }

  /**
   * Reads an extension without the device block.
   *
   * Used to tell "this extension is not there" apart from "the device block of
   * this build cannot answer": on the verified live build, asking for
   * `coreDevice.deviceId` of an extension that does not exist comes back as a
   * GraphQL *internal server error* instead of the plain
   * `Extension does not exists` the same build returns for a lighter query.
   */
  private async readExtensionLight(extensionId: string): Promise<FreePBXExtension | null | 'unavailable'> {
    const query = `query fetchExtension($extensionId: ID) {
      fetchExtension(extensionId: $extensionId) {
        status message id extensionId
        user { name outboundCid voicemail ringtimer noanswer noanswerDestination noanswerCid busyCid sipname password extPassword }
      }
    }`;
    try {
      const data = await this.execute<{ fetchExtension?: (FreePBXExtension & { status?: boolean; message?: string }) | null }>(
        query,
        { extensionId },
        'fetchExtension',
      );
      const ext = data.fetchExtension;
      if (!ext || ext.status === false) return null;
      return ext;
    } catch (err) {
      if (FreePBXGraphQLClient.isNotFoundText(err)) return null;
      logger.warn({ extension: extensionId, err: (err as Error).message }, 'light extension read also failed');
      return 'unavailable';
    }
  }

  async getExtension(extensionId: string): Promise<FreePBXExtension | null> {
    const query = `query fetchExtension($extensionId: ID) {
      fetchExtension(extensionId: $extensionId) {
        status message id extensionId
        user { name outboundCid voicemail ringtimer noanswer noanswerDestination noanswerCid busyCid sipname password extPassword }
        coreDevice { deviceId dial devicetype description emergencyCid tech callerId sipdriver }
      }
    }`;
    try {
      const data = await this.execute<{ fetchExtension?: (FreePBXExtension & { status?: boolean; message?: string }) | null }>(
        query,
        { extensionId },
        'fetchExtension',
      );
      const ext = data.fetchExtension;
      if (!ext || ext.status === false) return null;
      return ext;
    } catch (err) {
      /*
       * The PBX could not answer the full query. Ask the lighter one before
       * deciding: `null` means the extension genuinely is not there (which is a
       * normal answer for a read - it is how the allocator finds free numbers),
       * a result means the extension exists but this build cannot serve the
       * device block, and `unavailable` means we do not know and must not guess.
       */
      const light = await this.readExtensionLight(extensionId);
      if (light !== 'unavailable') return light;
      throw err;
    }
  }

  /** The PBX's ways of saying "there is no such extension" (builds differ). */
  static isNotFoundText(err: unknown): boolean {
    if (!(err instanceof FreePBXError)) return false;
    const text = `${err.message} ${JSON.stringify(err.detail ?? {})}`;
    return /does not exist|doesn't exist|not found|no such/i.test(text);
  }

  async getAllExtensions(): Promise<FreePBXExtension[]> {
    const query = `query { fetchAllExtensions {
      status message totalCount
      extension { id extensionId user { name outboundCid sipname } coreDevice { deviceId dial devicetype description tech } }
    } }`;
    const data = await this.execute<{ fetchAllExtensions?: { extension?: FreePBXExtension[] } }>(query, undefined, 'fetchAllExtensions');
    return data.fetchAllExtensions?.extension ?? [];
  }

  async createExtensionRange(startExtension: string, numberOfExtensions: number, opts: { name?: string; tech?: FreePBXTech } = {}): Promise<FreePBXResult> {
    const res = await this.mutateWithFallback<FreePBXResult>(
      'CreateRangeofExtensionInput',
      'createRangeofExtension',
      {
        startExtension,
        numberOfExtensions,
        tech: opts.tech ?? 'pjsip',
        name: opts.name ?? 'sipbot',
        umEnable: false,
      },
      'status message',
    );
    return res;
  }

  // ---------------------------------------------------------------------------
  // Inbound routes (DID -> extension) - documented: Core module GraphQL API
  // ---------------------------------------------------------------------------

  async createInboundRoute(input: InboundRouteInput): Promise<FreePBXResult & { routeId: string }> {
    const res = await this.mutateWithFallback<FreePBXResult & { inboundRoute?: { id: string } }>(
      'AddInboundRouteInput',
      'addInboundRoute',
      { ...input },
      'status message inboundRoute { id }',
    );
    if (!res.status || !res.inboundRoute?.id) {
      throw new FreePBXError(`FreePBX rejected addInboundRoute: ${res.message}`, 'REJECTED', { operation: 'addInboundRoute' });
    }
    logger.info(
      { routeId: res.inboundRoute.id, did: maskNumber(input.extension), destination: input.destination },
      'FreePBX inbound route created',
    );
    return { status: true, message: res.message, routeId: res.inboundRoute.id };
  }

  async updateInboundRoute(input: UpdateInboundRouteInput): Promise<FreePBXResult & { routeId: string }> {
    const res = await this.mutateWithFallback<FreePBXResult & { inboundRoute?: { id: string } }>(
      'UpdateInboundRouteInput',
      'updateInboundRoute',
      { ...input },
      'status message inboundRoute { id }',
    );
    if (!res.status || !res.inboundRoute?.id) {
      throw new FreePBXError(`FreePBX rejected updateInboundRoute: ${res.message}`, 'REJECTED', { operation: 'updateInboundRoute' });
    }
    return { status: true, message: res.message, routeId: res.inboundRoute.id };
  }

  async deleteInboundRoute(routeId: string): Promise<FreePBXResult> {
    const res = await this.mutateWithFallback<FreePBXResult>(
      'RemoveInboundRouteInput',
      'removeInboundRoute',
      { id: routeId },
      'status message deletedId',
    );
    if (!res.status) throw new FreePBXError(`FreePBX rejected removeInboundRoute: ${res.message}`, 'REJECTED', { operation: 'removeInboundRoute' });
    return res;
  }

  async getInboundRoute(routeId: string): Promise<FreePBXInboundRoute | null> {
    const query = `query inboundRoute($id: ID!) {
      inboundRoute(id: $id) {
        id extension cidnum description privacyman alertinfo ringing mohclass grppre
        delay_answer pricid pmmaxretries pmminlength reversal rvolume fanswer destinationConnection
      }
    }`;
    const data = await this.execute<{ inboundRoute?: FreePBXInboundRoute | null }>(query, { id: routeId }, 'inboundRoute');
    return data.inboundRoute ?? null;
  }

  async getAllInboundRoutes(): Promise<FreePBXInboundRoute[]> {
    const query = `query { allInboundRoutes {
      inboundRoutes {
        id extension cidnum description privacyman alertinfo ringing mohclass grppre
        delay_answer pricid pmmaxretries pmminlength reversal rvolume fanswer destinationConnection
      }
    } }`;
    const data = await this.execute<{ allInboundRoutes?: { inboundRoutes?: FreePBXInboundRoute[] } }>(query, undefined, 'allInboundRoutes');
    return data.allInboundRoutes?.inboundRoutes ?? [];
  }

  // ---------------------------------------------------------------------------
  // CDR (historical calls) - documented: CDR module GraphQL API
  // ---------------------------------------------------------------------------

  async getCdrs(query: CdrQuery): Promise<CdrPage> {
    const gql = `query fetchAllCdrs($first: Int, $after: Int, $orderby: CdrOrderByEnum, $startDate: String, $endDate: String) {
      fetchAllCdrs(first: $first, after: $after, orderby: $orderby, startDate: $startDate, endDate: $endDate) {
        cdrs {
          id uniqueid calldate timestamp clid src dst dcontext channel dstchannel lastapp lastdata
          duration billsec disposition accountcode userfield did recordingfile cnum outbound_cnum
          outbound_cnam dst_cnam linkedid peeraccount sequence amaflags
        }
        totalCount status message
      }
    }`;
    const data = await this.execute<{ fetchAllCdrs?: CdrPage }>(
      gql,
      {
        first: query.first ?? 100,
        after: query.after ?? 0,
        orderby: query.orderby ?? 'date',
        startDate: query.startDate,
        endDate: query.endDate,
      },
      'fetchAllCdrs',
    );
    const page = data.fetchAllCdrs;
    return { cdrs: page?.cdrs ?? [], totalCount: page?.totalCount ?? 0, status: page?.status ?? false, message: page?.message ?? '' };
  }

  async getCdr(id: string): Promise<CdrRecord | null> {
    const gql = `query fetchCdr($id: ID!) {
      fetchCdr(id: $id) {
        uniqueid calldate timestamp clid src dst dcontext channel dstchannel lastapp lastdata
        duration billsec disposition accountcode userfield did recordingfile cnum outbound_cnum
        outbound_cnam dst_cnam linkedid peeraccount sequence amaflags status message
      }
    }`;
    const data = await this.execute<{ fetchCdr?: CdrRecord | null }>(gql, { id }, 'fetchCdr');
    return data.fetchCdr ?? null;
  }
}
