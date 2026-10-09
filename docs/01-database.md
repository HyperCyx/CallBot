# Database

PostgreSQL 17. All state lives here; the application holds no authoritative
state of its own. Migrations are hand-written SQL in `migrations/` and are
checksum-verified — **never edit an applied migration**, add a new one.

```
npm run migrate      # apply pending migrations (idempotent, checksum verified)
npm run seed         # settings + roles + starter catalogue (idempotent)
```

## 1. ERD

```
                       ┌──────────────┐
                       │    roles     │
                       └──────┬───────┘
                              │ user_roles
                              ▼
┌──────────────┐      ┌──────────────┐       ┌──────────────┐
│telegram_acco │─────►│    users     │◄──────│    plans     │
│    unts      │      │ (app-level   │  plan │ (free/prem,  │
└──────────────┘      │  identity)   │       │  editable)   │
                      └──┬───┬───┬───┘       └──┬────────┬──┘
                         │   │   │              │plan_   │plan_
                         │   │   │              │countries│services
                         │   │   │              ▼        ▼
                         │   │   │        ┌──────────┐ ┌──────────┐
                         │   │   └───────►│ countries│ │ services │
                         │   │            └────┬─────┘ └────┬─────┘
                         │   │                 │ service_countries
                         │   │                 ▼            ▼
                         │   │            ┌──────────────────────┐
                         │   │            │       numbers        │
                         │   │            │  AVAILABLE/RESERVED/ │
                         │   │            │  ASSIGNED/SUSPENDED  │
                         │   │            └───────┬──────────────┘
                         │   │                    │ 1
                         │   │                    ▼ n
                         │   │        ┌────────────────────────┐
                         │   │        │   number_assignments   │
                         │   │        │ RESERVING/ACTIVE/...   │
                         │   │        └───────┬────────────────┘
                         │   │                │ 1
                         │   │                ▼ n (partial unique: one ACTIVE per number)
                         │   │     ┌──────────────────────────┐
                         │   │     │ inbound_route_mappings   │
                         │   │     │ freepbx_route_id, drift  │
                         │   │     └──────────────────────────┘
                         │   │
                         │   ▼  ┌──────────────────┐
                         │      │   sip_accounts   │  password_encrypted (AES-256-GCM)
                         │      └──────────────────┘
                         │      ┌──────────────────┐
                         │      │ extension_allocs │  extension pool (unique)
                         │      └──────────────────┘
                         ▼
                 ┌───────────────┐        ┌──────────────────────┐
                 │  referrals    │───────►│ referral_commissions │
                 │ UNIQUE(       │        │ snapshotted rate     │
                 │ referred_user)│        └──────────────────────┘
                 └───────────────┘        ┌──────────────────────┐
                                          │    call_history      │
   ┌──────────────┐   ┌───────────────┐   └──────────────────────┘
   │ audit_logs   │   │ call_sessions │   CDR (Hangup) → call_history
   │ hash chained │   │ AMI live      │   live calls → call_sessions
   └──────────────┘   └───────────────┘
   ┌──────────────┐   ┌───────────────┐   ┌────────────────────────┐
   │admin_settings│   │ freepbx_sync_ │   │ reconciliation_runs    │
   │ + defaults   │   │ jobs (queue)  │──►│ reconciliation_findings│
   └──────────────┘   └───────────────┘   └────────────────────────┘
```

**35 tables** (33 domain tables + `schema_migrations` + `setting_defaults`) and
4 reporting views: `v_admin_dashboard`, `v_user_numbers`, `v_offer_inventory`,
`v_referral_balances`.

## 2. Tables by domain

### Identity and access (migration 002)

*Migration 001 contains no tables*: it installs `pgcrypto`/`citext`, the
`set_updated_at()` trigger helper and the shared validation functions.

| Table | Purpose | Key constraints |
|---|---|---|
| `users` | application-level identity, status machine, plan, referral | `telegram_id` unique; `referral_code` unique |
| `telegram_accounts` | Telegram profile + ban state per account | PK telegram id |
| `roles`, `user_roles` | RBAC (super_admin/admin/support/user) | unique (user, role) |
| `bot_sessions` | grammY session persistence | PK key, `expires_at` index |

`users.status`: `PENDING → ACTIVE → BLOCKED/DELETED`, plus `EXPIRED`.
A user is only ever provisioned after an admin approval (or `bot.auto_approve`).

### SIP endpoints (003)

| Table | Purpose | Key constraints |
|---|---|---|
| `sip_accounts` | extension, technology, credentials, status | **one live account per extension and per user** — `uq_sip_accounts_extension_live` / `uq_sip_accounts_user_live`, both partial (`WHERE deleted_at IS NULL`, migration 013), so an extension can be recycled after an account is deleted while history rows keep it; `password_encrypted` (versioned `v1:iv:tag:ct`) |
| `extension_allocations` | every extension ever handed out, with reason | PK `extension`, one row per number kept as history; the allocator **reclaims** a row whose `released_at` is set and refuses to touch a live one, so the pool can never hand the same extension to two users |

### Catalog (004)

`countries`, `services`, `service_countries` (offer + per-offer inventory rules),
`plans`, `plan_countries`, `plan_services`. Nothing is hard-coded: the bot lists
exactly what these tables say.

### Inventory and assignment (005)

| Table | Purpose | Key constraints |
|---|---|---|
| `numbers` | DID inventory + status | `phone_number` unique; `status` CHECK |
| `number_assignments` | assignment history per number/user | `uq_number_assignments_active` — partial unique index on `number_id` `WHERE released_at IS NULL AND status NOT IN ('RELEASED','FAILED')` |
| `number_import_batches` | CSV/bulk import audit | — |

### Wallets, ledger and deposit requests (015)

| Table | Purpose | Key constraints |
|---|---|---|
| `wallets` | one USD balance per user, created lazily on first touch | `balance_cents >= 0` CHECK, `user_id` unique/PK |
| `wallet_transactions` | signed append-only ledger (`DEPOSIT`, `PURCHASE`, `REFUND`, `ADMIN_ADJUSTMENT`) carrying `balance_after_cents` | every movement is a guarded `UPDATE wallets … WHERE balance >= -amount` on the row lock in the same transaction, so concurrent debits can never overdraw; the ledger always sums to the balance |
| `deposit_requests` | manual-approval top-ups (`PENDING`/`APPROVED`/`REJECTED`/`CANCELLED`) | partial unique index `uq_deposit_requests_one_pending` — at most one `PENDING` row per user, enforced at the DATABASE level; approval joins request update + wallet credit in one `FOR UPDATE` transaction (double-approve is a verified no-op) |

Charging rule for a purchasable number: `numbers.price_cents` (explicit
override) else the active `service_countries` offer price, else free.

### Payment methods (016)

| Table | Purpose | Key constraints |
|---|---|---|
| `payment_methods` | admin-managed deposit gateways: name, icon, destination `address` (shown to users), instructions, ACTIVE/DISABLED, sort order | `slug` unique; seed ships Binance Pay + USDT TRC-20 **DISABLED** so no placeholder address ever reaches a user; hard delete is refused while a `deposit_requests.payment_method_id` references the method (disable instead) |

Requests filed through a method keep the method id; the admin ✅/❌ DM and the
Deposits queue show method + transaction id together.

**The double-assignment guarantee is enforced twice**: the partial unique index
above, and `SELECT … FOR UPDATE SKIP LOCKED` on `numbers` inside the assignment
transaction. A regression test races two users against one number and asserts
exactly one wins (`tests/assignment.test.ts`).

### Routing (006)

`inbound_route_mappings` records the *intended* route, the FreePBX route id, and
`drift_state` (`OK`/`MISSING_IN_PBX`/`MISMATCH`). `freepbx_sync_jobs` is the
queue (unique `idempotency_key`). Suspension **removes** the route; unsuspension
recreates it.

### Calls (007)

`call_history` (from `fetchAllCdrs`), `call_sessions` (from AMI, live),
`cdr_sync_state` (incremental sync watermark, gated by
`calls.cdr_sync_enabled`).

### Referrals (008)

`referral_codes`, `referrals` (`referred_user_id` UNIQUE,
`CHECK (referrer_user_id <> referred_user_id)`), `referral_commissions`
(unique `(referral_id, source)`, snapshotted `commission_type`/`rate_value`/
`base_amount_cents`). A qualified referral can never be paid twice, and a later
configuration change cannot rewrite a historical commission.

### Operations (009)

| Table | Purpose |
|---|---|
| `audit_logs` | append-only, hash-chained (`prev_hash`/`row_hash`) with trigger blocking UPDATE/DELETE |
| `admin_settings` | every tunable business rule, editable from the bot |
| `idempotency_keys` | API-layer replay protection (`key` + `scope`, request hash) |
| `notifications` | outbound queue with `dedupe_key` |
| `reconciliation_runs`, `reconciliation_findings` | drift reports and resolutions |
| `pbx_inventory_snapshot` | last observed PBX extensions/routes |
| `worker_heartbeats` | liveness of every background loop |
| `freepbx_compat` | compatibility probe results |

### Configuration defaults (012)

`setting_defaults` is the shipped default configuration, and
`seed_admin_settings()` / `seed_system_roles()` restore it idempotently — used by
the seed script and the test harness. Both are *defaults*, never runtime sources
of truth.

## 3. Invariants you can rely on

1. **One active assignment per number, ever.** Partial unique index + row locks.
2. **Ownership is provable.** Every change writes an `audit_logs` row
   (hash-chained); UPDATE/DELETE raise an exception.
3. **Secrets are never stored in clear text.** `sip_accounts.password_encrypted`
   is AES-256-GCM; the KEK is env/secret-manager only.
4. **Referral credit is unambiguous.** One referrer per referred user, self
   referrals rejected by CHECK and application guard.
5. **Settings are data.** Changing a limit or a commission rate is an
   `admin_settings` write, not a deploy.
6. **Nothing expires silently.** Expiry only suspends and flags unless
   `numbers.auto_release_on_expiry` is explicitly enabled.

## 4. Verify the schema yourself

```bash
psql "$DATABASE_URL" -c "\dt"                       # tables
psql "$DATABASE_URL" -c "\d numbers"                # columns, indexes, checks
psql "$DATABASE_URL" -c "SELECT * FROM v_admin_dashboard;"
npm run migrate                                      # "Database is up to date"
```

Audit integrity check:

```sql
SELECT * FROM audit_logs ORDER BY id DESC LIMIT 5;   -- prev_hash/row_hash present
```

`verifyAuditChain()` (in `src/db/migrate.ts`, also runnable from the admin panel's
health screen) re-derives every hash; tampering with a row — even with triggers
disabled — is detected.
