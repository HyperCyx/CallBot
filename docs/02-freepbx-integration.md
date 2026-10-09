# FreePBX integration

Target: **FreePBX 17 with the API module installed** (OAuth2 + GraphQL), AMI
enabled for live-call data. The backend is the only component that talks to the
PBX; Telegram never does.

> **Documentation rule (spec §40, §43).** Only operations that appear in Sangoma's
> official documentation are implemented. Anything that is not documented is
> described below as **"Not confirmed in the official API documentation."** — the
> code never invents an endpoint, a mutation or a parameter name, and the
> compatibility probe reports what your specific PBX actually exposes.

## 1. What is confirmed in the official documentation

Source: Sangoma FreePBX documentation, *API Applications* and *Core Module
GraphQL APIs*, plus the CDR module page for `fetchAllCdrs`/`fetchCdr`.

### Authentication

* API applications are created in the PBX GUI; **machine-to-machine
  applications use the OAuth2 client-credentials grant**, which is the correct
  choice for a backend (no user interaction).
* The GUI's **"API URL List"** page gives the exact OAuth **Authorize**,
  **Token** and **Resource** URLs plus the **GraphQL URL** and REST base URL.
  Those are pasted into `FREEPBX_TOKEN_URL` / `FREEPBX_GRAPHQL_URL` — they are
  read off *your* PBX, never guessed.
* A scope must be declared for the application (API Scope Visualizer); an app can
  authenticate successfully and still be rejected by every operation if the scope
  is wrong → `FREEPBX_SCOPE`.

Endpoint used: `POST {FREEPBX_GRAPHQL_URL}` (documented as
`/admin/api/api/gql`), with `Authorization: Bearer <access_token>`.

### Operations implemented

| Operation | Kind | What this platform uses it for |
|---|---|---|
| `addExtension` | mutation | create the SIP/PJSIP extension for an approved user |
| `updateExtension` | mutation | set the SIP secret (`extPassword`), caller ID, voicemail flags |
| `deleteExtension` | mutation | remove the endpoint when an account is deleted |
| `fetchExtension` | query | read one extension back (verification/reconciliation) |
| `fetchAllExtensions` | query | reconciliation: which extensions exist on the PBX |
| `fetchAllValidExtensions` | query | same, filtered list variant |
| `createRangeofExtension` | mutation | bulk extension pre-creation (operator convenience) |
| `addCoreDevice`, `updateCoreDevice`, `fetchCoreDevice`, `fetchAllCoreDevices`, `deleteCoreDevice` | mutation/query | device binding for an extension (tech/dial/description) |
| `updateAdvanceSettings`, `fetchAdvanceSetting`, `fetchAllAdvanceSettings` | mutation/query | read/write advanced settings (used by the compat probe) |
| `addInboundRoute` | mutation | point a DID at an extension |
| `updateInboundRoute` | mutation | re-point/re-describe a route (reconciliation) |
| `removeInboundRoute` | mutation | release/suspend a number |
| `allInboundRoutes` | query | reconciliation: which routes exist on the PBX |
| `inboundRoute(id:)` | query | read one route (`id` = `"<extension>/<cidnum>"`) |
| `fetchAllCdrs`, `fetchCdr` | query | call history ingestion |

Documented details the implementation relies on:

* **Inbound route identity is `"<extension>/<cidnum>"`** — the route "number"
  (the DID/extension it matches) plus the caller-ID pattern. This platform stores
  that string in `inbound_route_mappings.freepbx_route_id`.
* **Destination format** is the documented `destinationConnection` string; the
  example in the docs is `from-did-direct,100,1` (extension technology, extension
  number, priority). The template is configurable:
  `FREEPBX_ROUTE_DESTINATION_TEMPLATE=from-did-direct,{ext},1`.
* **`fetchExtension` never returns a plaintext secret.** The documented response
  exposes `user.extPassword` as a *hashed* value. Consequence: the local,
  AES-256-GCM-encrypted copy in `sip_accounts.password_encrypted` is
  authoritative for the credential we handed the user; the PBX is authoritative
  for everything else.
* **`addExtension` has no password field.** The SIP secret is therefore set in a
  second, explicit `updateExtension` call (`extPassword`) immediately after
  creation. If that call fails, provisioning fails loudly rather than leaving an
  endpoint with an unknown secret.
* **The CDR API has no live-call operation.** Live calls come from AMI
  (`CoreShowChannels`/events), never from the CDR module.

## 2. Not confirmed in the official API documentation

These are the deliberate gaps. Each one is handled without inventing API surface:

| Question | Handling |
|---|---|
| Is there a GraphQL operation that returns the **PBX/Asterisk version**? | **Not confirmed in the official API documentation.** `detectVersion()` returns `null` for unknown fields; version strings are only reported when the probe finds them. |
| Exact **input field names** of `updateInboundRoute` (does it take the old identity, a route id, or the full tuple?) | **Not confirmed in the official API documentation.** The client sends `oldExtension`/`oldCidnum` plus the new `extension`/`cidnum`/`destination`, and the probe verifies via **GraphQL introspection** which fields your PBX's schema actually declares. If the mutation rejects the call, it is reported as `PBX_REJECTED` in the audit log — never retried blindly. |
| Is there a documented **live/active calls** query? | **Not confirmed in the official API documentation** → AMI is used instead. |
| Does the API expose **trunk/outbound route** management for DID provisioning? | **Not confirmed in the official API documentation.** DIDs are wired to inbound routes only; trunk configuration remains an operator task outside this platform. |
| CDR **paging semantics** beyond the documented page/limit parameters | **Not confirmed in the official API documentation.** `ingestCdrs()` walks pages until a short page is returned and records the watermark in `cdr_sync_state`. |
| Whether `createRangeofExtension` sets a password per extension | **Not confirmed in the official API documentation.** The platform does not depend on it; bulk creation is an operator convenience only. |

## 3. OAuth2 token handling

`src/freepbx/oauth.ts`:

* client-credentials grant against `FREEPBX_TOKEN_URL`;
* the access token is cached **in memory only**, refreshed shortly before expiry,
  and guarded by a mutex so concurrent operations share one refresh;
* tokens are never logged, never written to the database, and are redacted from
  error payloads (the logger has a redaction list for `client_secret`,
  `access_token`, `password`, `authorization`);
* failures increment `oauth_failures_total` and surface as
  `PBX_UNAVAILABLE`/`PBX_REJECTED`, both of which the bot renders as a plain
  "try again in a moment" message.

## 4. Resilience rules

| Situation | Behaviour |
|---|---|
| Connection refused / DNS failure / unreachable | Automatic retry (bounded by `FREEPBX_MAX_RETRIES`) |
| Timeout on a **query** | Retried |
| Timeout/network error on a **mutation** | **Never auto-retried** — the mutation may have succeeded. Verified by the reconciler, and the number returns to AVAILABLE only when the PBX is provably unchanged |
| `status: false` from FreePBX | `PBX_REJECTED` with the PBX's own message preserved in the audit row |
| Auth failure | Token refreshed once; if it still fails the operation is refused and alerted |
| PBX is in `mock` mode | `MockFreePBXClient` — no network traffic, deterministic, supports fault injection for tests |

Every PBX call records a latency metric (`freepbx_latency_ms`) and an audit row
for state-changing operations.

## 4b. Verified against a live PBX (build-specific behaviour)

The wiki describes the *reference* API. A real deployment differs, and this
platform was brought up against one (FreePBX 17, API module, scope `gql`).
Everything below was confirmed by raw introspection and by watching the
mutations actually land, and the code now adapts to the deployment instead of
assuming the documentation:

| What the docs say | What the live build does | How the code handles it |
|---|---|---|
| `coreDevice { callerId sipdriver }` | those two fields do not exist on `coredevice`; selecting either makes the PBX reject the **whole** query | `execute()` strips a field the PBX calls missing, logs one WARN, records it in `schemaDeviations()` and retries — the query is never sent twice and nothing is invented (see the drift tests) |
| input type `AddExtensionInput` | `addExtensionInput` | the mutation's variable type is read from the PBX's own Mutation signature |
| `outboundCID`, `emergencyCID` | `outboundCid`, `emergencyCid` | keys are matched against the schema **case-insensitively**; the PBX's spelling wins |
| `maxContacts: 2` (Int) | `maxContacts` is a **String** — an integer fails the entire mutation with `String cannot represent a non string value: 2` | values are coerced to the scalar the schema declares |
| `umEnable: false` (no user-manager account) | accepted at create time, but **every later `updateExtension` then answers `{status: null}`** and the SIP secret is never applied — a silent, total provisioning failure | `umEnable` is simply not sent unless a caller explicitly asks for user management; `umEnable: true` additionally requires `umPassword`, exactly as the PBX demands |
| `updateExtension` returns `{status}` | `status: true` alone is not proof the secret landed (see above) | after setting `extPassword` the client **reads the extension back**: if the PBX kept its own secret, the user is told the PBX-generated password (the platform never reports a password that is not in force) |

**The PBX is the authority on which extension numbers are free.** The configured
`EXTENSION_RANGE_*` can overlap numbers an operator created by hand, and an
interrupted job can leave one behind. So `provisionSipAccount` probes each
candidate (`fetchExtension`) before writing, skips any number the PBX already
owns (it is never reused or overwritten), and retries the next candidate after a
`already in use` / `already exists` answer — up to 25 candidates, after which it
fails with `NO_INVENTORY` telling the operator to widen the range.

```
FREEPBX_MODE=graphql
npm run probe                       # read-only: 13/13 operations, 0 missing
npx tsx scripts/inspect-pbx.ts      # PBX inventory vs our DB, range collisions
npx tsx scripts/prune-extensions.ts # report extensions whose owner is gone
npx tsx scripts/prune-extensions.ts --apply
```

## 5. AMI (live calls)

`src/freepbx/ami.ts` implements the AMI protocol directly over TCP (no
dependency on the AMI module's REST endpoints, which are not what the spec
allows to be assumed):

* login (`Action: Login`), then an event stream subscription;
* `Newchannel`/`Newstate`/`Hangup`/`Dial`/`Bridge` events map to
  `call_sessions` rows (state, direction inferred from the documented
  `PJSIP/`-style channel names, configurable via `AMI_INBOUND_CHANNEL_PREFIX`);
* `CoreShowChannels` is used on startup for catch-up;
* reconnection with backoff; `AMI_TLS`/`AMI_TLS_VERIFY` supported;
* if `AMI_ENABLED=false`, live views degrade gracefully (`liveCallSourceStatus()`
  reports unavailable and the bot says so instead of showing a stale list).

## 6. Capability probe

```bash
npm run probe        # FREEPBX_MODE=graphql, read-only
```

* authenticates, then introspects the GraphQL schema;
* checks every operation in the table above for presence;
* stores the report in `freepbx_compat` (visible in the admin panel's health
  screen and served by `GET /api/admin/pbx/compat`);
* exit code 2 means "operations missing" — read the report before deploying.

## 7. Mock mode

```
FREEPBX_MODE=mock     # default in .env.example; required for tests
```

`MockFreePBXClient` implements the same `FreePBXBackend` interface with an
in-memory PBX: extensions, routes (with the documented
`"<extension>/<cidnum>"` identity), CDRs, and `failNextOperation()` for fault
injection (used by the assignment rollback and reconciliation tests). The
production client and the mock are interchangeable, which is why the entire
integration test suite runs without a PBX.
