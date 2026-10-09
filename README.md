# SIP bot — multi-user SIP/DID management through Telegram

Production-ready platform that provisions and manages SIP endpoints on FreePBX
(Asterisk) for many users, controlled primarily through a Telegram bot, with
PostgreSQL as the single source of truth.

```
/start → captcha → admin approval → SIP extension (FreePBX)
       → test number → Main Menu → Get Number → Country → Service
       → assigned number + SIP credentials
```

* **Stack**: TypeScript (ESM, Node ≥ 20) · grammY · raw `pg` + hand-written SQL
  migrations · PostgreSQL 17 · FreePBX 17 GraphQL (OAuth2 client credentials) +
  AMI for live calls · Express internal API · pino.
* **Status**: 156 tests green against a real PostgreSQL 17, typecheck clean,
  smoke test 17/17 against a **live FreePBX 17** (see
  `docs/02-freepbx-integration.md` §4b for the build-specific behaviour it adapts to).

## Hard rules this project follows

| Rule | How it is honoured |
|---|---|
| Telegram never talks to FreePBX | the backend is the only PBX client; the bot renders state only |
| Never invent FreePBX API surface | only documented operations are implemented; everything else is listed as **"Not confirmed in the official API documentation"** in `docs/02-freepbx-integration.md` |
| Everything database-driven | countries, services, plans, prices, commissions, limits and feature switches live in tables and are editable from the admin panel — nothing is hard-coded |
| Atomic number assignment | `SELECT … FOR UPDATE SKIP LOCKED` + partial unique index; a raced double-assignment test proves only one user can ever receive a number |
| No OTP interception, code harvesting, spoofing or spam | not implemented anywhere; the platform manages endpoints the operator owns |
| No secrets in logs or code | env/secret-manager only; SIP secrets AES-256-GCM at rest; audit metadata scrubbed |

## Quick start (local)

```bash
cp .env.example .env          # set DATABASE_URL, API_KEY, SIGNING_KEY at minimum
npm ci

npm run migrate               # 001..012, checksum-verified, idempotent
npm run seed                  # settings + roles + starter catalogue
npm run test:db && npm test   # optional: 156 tests against a real PostgreSQL
npm run dev                   # API + bot + workers  (or: npm run build && npm start)
npm run smoke                 # end-to-end journey through the running API
```

The bot is disabled when `TELEGRAM_BOT_TOKEN` is empty — the API and workers
still run, which is how the test environment works.

### Docker

```bash
cp .env.example .env && echo "POSTGRES_PASSWORD=$(openssl rand -hex 16)" >> .env
docker compose up -d --build
docker compose run --rm migrate && docker compose run --rm seed
```

## Documentation

| Doc | Contents |
|---|---|
| [`docs/00-architecture.md`](docs/00-architecture.md) | system context, processes, layers, flows, folder structure |
| [`docs/01-database.md`](docs/01-database.md) | ERD, all 35 tables, invariants |
| [`docs/02-freepbx-integration.md`](docs/02-freepbx-integration.md) | OAuth2, documented GraphQL operations, **unconfirmed** items, AMI, resilience |
| [`docs/03-telegram-bot.md`](docs/03-telegram-bot.md) | middleware order, user journey, admin panel, navigation/back button, operator bootstrap, callbacks, notifications |
| [`docs/04-api.md`](docs/04-api.md) | internal HTTP API reference with examples |
| [`docs/05-configuration.md`](docs/05-configuration.md) | every environment variable and `admin_settings` switch |
| [`docs/06-deployment.md`](docs/06-deployment.md) | deploy, TLS, FreePBX setup, scaling, backups, monitoring |
| [`docs/07-security.md`](docs/07-security.md) | 46-point security checklist with residual risks |
| [`docs/08-testing.md`](docs/08-testing.md) | suites, harness, how to add tests, CI |
| [`docs/09-runbook.md`](docs/09-runbook.md) | operations, incident playbooks, investigation queries |

## Feature map

| Area | Where | Notes |
|---|---|---|
| Telegram bot (grammY) | `src/bot/` | sessions in PostgreSQL, RBAC, CAPTCHA, rate limits, full admin panel |
| Admin panel | `src/bot/handlers/admin.ts` + `/api/admin/*` | users, inventory, catalog, plans, referrals, reconciliation, settings, health |
| Number inventory | `src/services/inventory.service.ts` | single/bulk/CSV import, dedupe, per-country validation, batches |
| DID assignment | `src/services/assignment.service.ts` | reserve → PBX → commit, 10-minute reservations, wallet charged inside the reserve transaction, reassign/suspend/release |
| Wallets & deposits | `src/services/wallet.service.ts` + `src/services/deposit.service.ts` | per-user USD balance, signed ledger, manual-approval deposits with admin-managed payment methods (method → amount → address → TXID → ✅/❌ DM), admin direct funding, automatic refund when a paid assignment fails |
| SIP accounts | `src/services/extension.service.ts` | pooled extensions, AES-256-GCM secrets, rotation, audited reads |
| Routing | `src/services/routing.service.ts` | documented destination template, drift detection, map of intended vs actual |
| Live calls | `src/services/call.service.ts` + `src/freepbx/ami.ts` | AMI event stream → `call_sessions` |
| CDR | `src/services/call.service.ts` | `fetchAllCdrs` → `call_history` with a sync watermark |
| Referrals | `src/services/referral.service.ts` | one attribution per user, snapshotted commissions, caps and holds |
| Plans | `src/services/catalog.service.ts` + `plans` table | internal only — never shown in the bot UI; what users see is price/freeness per country (USD) and their wallet balance |
| Audit logging | `src/services/audit.service.ts` + migration 009/011 | append-only, hash-chained, tamper-detecting |
| Reconciliation | `src/workers/reconcile.worker.ts` | additive fixes automatic, destructive changes reported |
| Workers | `src/workers/` | jobs, notifications, CDR, live calls, reconciliation, expiry |
| Internal API | `src/api/server.ts` | keyed, IP-allowlisted, rate limited, idempotent |
| Docker / CI | `Dockerfile`, `docker-compose.yml`, `.github/workflows/ci.yml` | non-root image, healthchecks, 3 CI jobs |
| Migrations | `migrations/` | 16 forward-only files plus reporting views |
| Tests | `tests/` | 173 tests: concurrency, rollback, wallet atomicity (insufficient-funds/reservation/refund/double-approve, deposit method guard), extension recycling, audit tamper, API, reconciliation, bot UX, removal navigation, unit |

## Ops CLIs

```bash
npm run migrate      # apply pending migrations (checksum-verified)
npm run seed         # idempotent configuration + starter catalogue
npm run probe        # FreePBX compatibility probe (read-only)
npm run reconcile    # DB vs PBX drift: auto-fix safe, report the rest
npm run smoke        # full journey through the running API (17 checks)
npm run smoke -- --live    # same journey, but against the REAL PBX (creates and
                           # removes a test extension + route; re-run
                           # inspect-pbx.ts afterwards to confirm the PBX is clean)

# operator tools for a live PBX
npx tsx scripts/inspect-pbx.ts        # PBX extensions/routes vs our database, range collisions
npx tsx scripts/prune-extensions.ts   # list extensions whose owner no longer exists
npx tsx scripts/prune-extensions.ts --apply   # remove them from the PBX + close the DB rows
npx tsx scripts/reset-demo.ts         # reset demo/operator accounts to PENDING
```

## Safety model in one paragraph

Numbers are reserved under a row lock and only become `ASSIGNED` after the
FreePBX inbound route exists; any failure rolls the number back to `AVAILABLE`
and writes an audit row. Every action — approval, assignment, suspension,
credential read, setting change — is attributed and hash-chained. Reconciliation
only ever *repairs* (recreates a missing route, re-points a drifted one, releases
a stale reservation); anything destructive or ambiguous becomes a finding for a
human, because a deleted extension or a foreign route may be intentional.
