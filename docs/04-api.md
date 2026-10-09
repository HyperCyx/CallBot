# Internal HTTP API

The backend's control plane: what the bot handlers call, what an external
operator console can call, and what monitoring scrapes. It is **not** a
user-facing API — Telegram users never touch it, and it exposes no FreePBX
credentials.

Base URL: `http://API_HOST:API_PORT` (default `0.0.0.0:8080`).

## 1. Authentication and safety rails

| Control | Behaviour |
|---|---|
| `x-api-key` | Required on every `/api/*` route; compared in constant time |
| `API_IP_ALLOWLIST` | Optional CIDR list; a request from outside it gets `403` |
| Rate limit | `API_RATE_LIMIT_PER_MIN` per IP, sliding window → `429` |
| `Idempotency-Key` | On mutating routes: the stored response is replayed, the side effect runs once |
| `x-actor-user-id` | The acting admin. Required for operations that must be attributable (number import, credential reads) |
| `x-request-id` | Optional; echoed back and stored in audit rows |
| Body limit | 5 MB (CSV uploads) |

Error envelope (always):

```json
{ "error": { "code": "BAD_INPUT", "message": "…", "details": { } }, "requestId": "api-…" }
```

Codes: `BAD_INPUT` (400), `UNAUTHORIZED` (401), `FORBIDDEN`/`ACCOUNT_NOT_ACTIVE`
(403), `NOT_FOUND`/`NO_INVENTORY` (404), `CONFLICT`/`PLAN_LIMIT`/
`NUMBER_NOT_AVAILABLE` (409), `RATE_LIMITED` (429), `PBX_UNAVAILABLE`/
`PBX_REJECTED`/`RECONCILE_REQUIRED` (502), `INTERNAL` (500).

`message` is user-safe by construction: internal detail goes to the log and the
audit row, never to the response.

## 2. Unauthenticated endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | `200`/`503` with database, FreePBX, AMI and version state |
| `GET` | `/metrics` | Prometheus text exposition (`text/plain; version=0.0.4`) |
| `GET` | `/metrics.json` | Same data as JSON, plus the dashboard aggregate |
| `POST` | `/telegram/webhook` | Telegram updates; requires `x-telegram-bot-api-secret-token` (`401` otherwise) |

```bash
curl -s localhost:8080/health | jq
curl -s localhost:8080/metrics | grep sipbot
```

## 3. Users

| Method | Path | Body / notes |
|---|---|---|
| `GET` | `/api/admin/users?status=&search=&limit=&offset=` | `{ data: [...], total }` |
| `POST` | `/api/admin/users/:id/approve` | Approves, then provisions the SIP account; returns `{ user, sip, warning }` — a PBX outage does **not** undo the approval |
| `POST` | `/api/admin/users/:id/block` | `{ reason }` |
| `POST` | `/api/admin/users/:id/unblock` | — |
| `DELETE` | `/api/admin/users/:id` | **Deleting an account removes its number(s) with it.** `src/services/userDeletion.service.ts` does, in order: release every number the account holds (ASSIGNED / SUSPENDED / RESERVED — the DID route is removed first), delete the SIP account and its PBX extension, then soft-delete the user. Nothing is left assigned to a deleted account and no route is left pointing at a dead extension. Returns `{ deleted, releasedNumbers, sipAccountDeleted }`; every step is audited (`NUMBER_RELEASED`, `SIP_ACCOUNT_DELETED`, `USER_DELETED`) |
| `GET` | `/api/admin/users/:id/sip` | Credentials; **requires `x-actor-user-id`** and writes a `SIP_PASSWORD_VIEWED` audit row |

## 4. Numbers

| Method | Path | Body |
|---|---|---|
| `GET` | `/api/admin/numbers?status=&countryId=&serviceId=&assignedUserId=` | list + total |
| `POST` | `/api/admin/numbers/import` | `{ countryId, serviceId, planType, numbers[] \| csv, actorId? }` → `{ imported, duplicates, invalid, skippedAssigned, errors[] }` |
| `POST` | `/api/admin/numbers/assign` | `{ userId, countryId?, serviceId?, planType?, numberId?, actorId?, replaceOldest? }` → `{ numberId, phoneNumber, extension, routeId, assignmentId, expiresAt, replacedNumbers? }`. With `replaceOldest: true` a full plan does not fail: the new number is assigned first, then the oldest held number is released back to inventory and reported in `replacedNumbers` |
| `POST` | `/api/admin/numbers/reassign` | `{ numberId, toUserId, actorId }` |
| `POST` | `/api/admin/numbers/release` | `{ numberId, actorId, reason? }` — removes the route |
| `POST` | `/api/admin/numbers/suspend` | `{ numberId, actorId, reason? }` — removes the route, keeps ownership |
| `POST` | `/api/admin/numbers/unsuspend` | `{ numberId, actorId }` — recreates the route |
| `DELETE` | `/api/admin/numbers/:id` | `{ actorId, reason? }` — releases first, then soft-deletes |
| `GET` | `/api/admin/numbers/removal-preview?countryId=&serviceId=` | `{ available, assigned, suspended, reserved, other }` — what a bulk removal would take and what it must leave alone |
| `DELETE` | `/api/admin/numbers?countryId=&serviceId=` | Removes every **AVAILABLE** number (optionally scoped). `ASSIGNED`/`SUSPENDED`/`RESERVED` rows are never touched and are reported back in `kept` |

Import rules: numbers are normalised to E.164, must match the selected country's
dial code, are deduplicated inside the file and against the inventory, and the
import is refused if the country/service is not `ACTIVE`. Existing rows are never
mutated: an already-assigned number is reported in `skippedAssigned`, not
overwritten.

## 5. Catalog and plans

| Method | Path |
|---|---|
| `GET`/`POST` | `/api/admin/services` |
| `POST`/`PATCH` | `/api/admin/services/:id` |
| `DELETE` | `/api/admin/services/:id` | Removes the service and its `AVAILABLE` numbers + offers. `409` while a number of the service is `ASSIGNED`/`SUSPENDED`; pass `?force=1` (or `{"force":true}`) to revoke those numbers from their holders instead — route removed first, number retired, holder notified |
| `GET`/`POST` | `/api/admin/countries` | Adding a country whose ISO2 was previously removed **revives** that row (live duplicates still answer `409`) |
| `DELETE` | `/api/admin/countries/:id` | Same contract as the service removal, including `?force=1`. Both return `{ availableNumbers, revokedNumbers, affectedUsers, offers }` |
| `GET`/`POST` | `/api/admin/plans` |
| `PATCH` | `/api/admin/plans/:id` |

These are the only way to change pricing and availability outside the admin
panel. Nothing about the catalogue is compiled into the application.

## 6. Calls

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/admin/live-calls` | AMI-backed snapshot; reports `available: false` when AMI is off |
| `GET` | `/api/admin/calls?did=&limit=&offset=` | System-wide history |
| `GET` | `/api/users/:id/calls` | A single user's history (what the bot shows) |
| `POST` | `/api/admin/calls/sync` | Force a CDR ingest (`fetchAllCdrs` → `call_history`) |

## 7. Referrals

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/referrals/validate` | `{ code }` → whether the code exists and the programme is enabled |
| `GET` | `/api/admin/referrals/:userId` | Per-referrer stats |
| `POST` | `/api/admin/referrals/:id/reject` | `{ reason, actorId }` |

Qualification itself is event-driven (registration, approval, first assignment,
plan purchase) and idempotent; there is no "crediting" endpoint to abuse.

## 8. Operations

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/admin/dashboard` | Counts for the admin dashboard (users, numbers by status, revenue, findings) |
| `GET` | `/api/admin/audit?action=&actorId=&limit=&offset=` | Audit trail (read-only by design) |
| `GET` | `/api/admin/settings` | All `admin_settings` rows with type/category/label |
| `PATCH` | `/api/admin/settings/:key` | `{ value, actorId }` — validated against `value_type` |
| `POST` | `/api/admin/reconcile/run` | Run reconciliation now (`{ autoFix?, alert? }`) |
| `GET` | `/api/admin/reconcile/findings?limit=` | Open findings |
| `POST` | `/api/admin/reconcile/findings/:id/resolve` | `{ actorId }` |
| `GET` | `/api/admin/pbx/jobs` | Recent `freepbx_sync_jobs` |
| `GET` | `/api/admin/pbx/compat` | Last compatibility probe report |
| `POST` | `/api/admin/pbx/probe` | Run a probe now (read-only against the PBX) |
| `POST` | `/api/admin/maintenance/purge-sessions` | Drop expired `bot_sessions` |

## 9. Examples

```bash
API=http://127.0.0.1:8080
KEY=$(grep '^API_KEY=' .env | cut -d= -f2)

# Health
curl -s $API/health | jq '.status, .database.ok'

# Import a batch of DIDs (idempotent)
curl -s -X POST $API/api/admin/numbers/import \
  -H "x-api-key: $KEY" -H 'content-type: application/json' \
  -H 'idempotency-key: import-2026-10-07' \
  -d '{"countryId":"<uuid>","serviceId":"<uuid>","planType":"FREE",
       "numbers":["+971501234567","+971501234568"],"actorId":"<admin-uuid>"}'

# Assignment through the same path the bot uses
curl -s -X POST $API/api/admin/numbers/assign \
  -H "x-api-key: $KEY" -H 'content-type: application/json' \
  -d '{"userId":"<user-uuid>","countryId":"<uuid>","serviceId":"<uuid>","actorId":"<admin-uuid>"}'
```

A runnable end-to-end walkthrough of these calls is `npm run smoke` — it
executes the full journey and prints a pass/fail checklist.
