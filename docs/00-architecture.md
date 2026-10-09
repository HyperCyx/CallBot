# Architecture

Multi-user SIP/DID management platform controlled primarily through a Telegram
bot, backed by PostgreSQL and FreePBX/Asterisk.

---

## 1. System context

```
        ┌────────────┐        Telegram Bot API (webhook or long polling)
        │  Telegram  │◄───────────────────────────────┐
        │   users    │─────────── updates ───────────► │
        └────────────┘                                │
                                                      ▼
                                            ┌───────────────────┐
                                            │  Node.js / TS     │
                                            │  backend (grammY) │
                                            └─────────┬─────────┘
                              ┌───────────────────────┼───────────────────────┐
                              ▼                       ▼                       ▼
                     ┌────────────────┐      ┌────────────────┐      ┌────────────────┐
                     │  PostgreSQL 17 │      │  FreePBX 17    │      │  Operators     │
                     │  (source of    │      │  GraphQL API   │      │  (internal     │
                     │   truth)       │      │  + AMI         │      │   HTTP API)    │
                     └────────────────┘      └────────────────┘      └────────────────┘
```

Hard rules this design enforces:

* **Telegram never talks to FreePBX.** Every PBX operation is performed by the
  backend. The bot only renders state and triggers backend services.
* **PostgreSQL is the source of truth.** Numbers, assignments, routes, plans,
  commissions and settings live in the database — never in code or in the bot's
  memory. FreePBX is treated as a system to be reconciled *to*, not one to be
  trusted blindly.
* **Every mutation is auditable and idempotent.** Hash-chained audit rows,
  `idempotency_keys`, and a jobs table with unique idempotency keys.

## 2. Processes

| Process | Entry point | Responsibility |
|---|---|---|
| **App** | `src/index.ts` → `dist/index.js` | HTTP API, Telegram bot (webhook or polling), in-process workers, graceful shutdown |
| **Worker** | `src/worker.ts` → `dist/worker.js` | AMI event stream (live calls), CDR ingestion, reconciliation, job + notification queues, expiry sweeps |
| **Migrate / seed** | `scripts/migrate.ts`, `scripts/seed.ts` | Checksum-verified migrations and idempotent configuration seeding |
| **Ops CLIs** | `scripts/smoke.ts`, `scripts/probe.ts`, `scripts/reconcile.ts` | Post-deploy verification, FreePBX compatibility probe, on-demand reconciliation |

Splitting the worker out is optional (`docker-compose.yml` runs it separately).
Running both in one process is supported: the job runner uses
`FOR UPDATE SKIP LOCKED`, so multiple instances never process the same job.

## 3. Layers

```
src/
├── config/env.ts            zod-validated environment (fail-fast in production)
├── lib/                     logger, crypto, errors, phone, rate-limit, time, metrics
├── db/                      pool, transactions, advisory locks, migration runner
├── freepbx/                 OAuth2 client, GraphQL client, mock, AMI, compat probe
├── services/                business logic - one module per domain
├── workers/                 background loops (reconcile, jobs, notifications, CDR)
├── bot/                     grammY bot: middleware, sessions, keyboards, handlers
├── api/server.ts            internal HTTP API + Telegram webhook
├── index.ts                 application entry point
└── worker.ts                standalone worker entry point
migrations/                  hand-written SQL, checksum-verified, append-only history
scripts/                     migrate, seed, smoke, probe, reconcile, test-db
tests/                       integration + unit suites (real PostgreSQL)
docs/                        this documentation set
```

### Dependency direction

`bot → services → db` and `api → services → db`. Services never import bot or API
code; only `services` may touch `freepbx/*` clients. This keeps the PBX
integration in one layer (auditable, mockable) and the bot layer purely
presentational.

### Why raw `pg` and not an ORM

The core guarantee of this platform (spec §14) is **atomic number assignment
under concurrency**. That requires `SELECT … FOR UPDATE SKIP LOCKED`, partial
unique indexes, `pg_advisory_xact_lock`, `SET LOCAL statement_timeout`, and
trigger-maintained hash chains. Hand-written SQL keeps those visible and
reviewable instead of hidden behind an ORM's abstractions.

## 4. Request and update flows

### Telegram update

```
update → request id + logging → PostgreSQL session (bot_sessions)
       → identity/RBAC (upsert telegram_accounts, resolve role, ban check)
       → per-user rate limit (sliding window, DB-configured)
       → command / callback / text router (by session.step)
       → service call → PBX (if required) → audit + notification queue
       → rendered reply (editMessageText or reply)
```

### Number assignment (spec §14)

```
tx1  lock user row → verify status/plan limit → SELECT ... FOR UPDATE SKIP LOCKED
     → mark RESERVED (10 min TTL) → create assignment (RESERVING)
PBX  create inbound route (parameterised destination from settings)
tx2  mark ASSIGNED + assignment ACTIVE + mapping ACTIVE + audit
fail → number back to AVAILABLE, assignment FAILED, audit NUMBER_ASSIGNMENT_FAILED
```

PBX I/O happens **outside** database transactions, so a slow or failing PBX can
never hold a row lock; a reconciler (`finaliseStuckAssignments`) repairs the
narrow window where the PBX succeeded but the commit did not.

### Pending state after a crash

| State | Recovery |
|---|---|
| `numbers.status = RESERVED` past TTL | `releaseStaleReservations()` → AVAILABLE |
| assignment `RESERVING`, route healthy | `finaliseStuckAssignments()` → ASSIGNED |
| route missing/drifted on the PBX | reconciliation auto-fix or admin finding |
| job stuck `RUNNING` | `requeueStuckJobs()` with attempt counting |

## 5. Background workers

| Worker | Default interval | Purpose |
|---|---|---|
| jobs | 15 s | `freepbx_sync_jobs` queue (route create/update/delete, extensions) |
| notifications | wake-on-`LISTEN/NOTIFY` (~250 ms; poll every 20 s as backstop) | outbound Telegram messages with dedupe keys and retry |

Enqueue performs `INSERT` + `pg_notify('notifications_due','')` (fire-and-forget). A dedicated, self-reconnecting LISTEN client pokes a debounced single-flight scheduler that sweeps the outbox immediately, so an admin approval request lands in ~1 s instead of up to a poll interval late. Failed deliveries retry at 10 s/20 s/40 s… (previously whole-minute steps, which made one blip look like a lost message); the table remains the source of truth, so NOTIFY loss only ever costs one poll interval.
| CDR sync | 120 s | `fetchAllCdrs` → `call_history` per user |
| live calls | 30 s | AMI event stream → `call_sessions` (only when `AMI_ENABLED`) |
| reconciliation | 300 s | DB vs PBX drift: auto-fix additive, report the rest |
| expiry sweep | hourly | plan/number expiry, suspension, notices |

Each worker writes a `worker_heartbeats` row so `GET /health` and the admin
dashboard can show whether the background plane is alive.

## 6. Security posture

* Secrets only from the environment / secret manager. SIP passwords are
  AES-256-GCM encrypted with a KEK that never lives in the database.
* Admin credential reads require a reason and produce a `SIP_PASSWORD_VIEWED`
  audit row.
* The internal API is keyed (`x-api-key`, constant-time compared), optionally
  IP-allowlisted, rate limited, and idempotency-protected.
* The Telegram webhook is verified against `TELEGRAM_WEBHOOK_SECRET` on every
  request; long polling is used when no public URL is available.
* Banned users' updates are dropped before any handler runs.
* Full checklist: `docs/07-security.md`.

## 7. Non-goals (spec preamble)

No OTP interception, no verification-code harvesting, no spam calling, no
caller-ID spoofing, no bypassing of third-party platform restrictions. The
platform manages numbers and SIP endpoints the operator is entitled to use.
