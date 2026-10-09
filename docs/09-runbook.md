# Operations runbook

Day-2 operations: what to watch, what to do when something breaks, and how to
answer "what happened to this number?" in one query.

## 1. Daily checklist (2 minutes)

```bash
curl -s localhost:8080/health | jq '{status, database: .database.ok, freepbx: .freepbx.ok, ami: .ami.available}'
npm run reconcile                       # or open the admin panel → 🔁 Reconciliation
psql "$DATABASE_URL" -c "SELECT worker, status, last_success_at, last_error FROM worker_heartbeats ORDER BY worker;"
psql "$DATABASE_URL" -c "SELECT severity, finding_type, count(*) FROM reconciliation_findings WHERE resolved_at IS NULL GROUP BY 1,2;"
npx tsx scripts/prune-extensions.ts   # extensions whose owner is gone (report only)
```

In Telegram: **🛠 Admin Panel** → 📊 Dashboard and 🩺 Health.

## 2. Incident playbooks

### The bot does not answer

1. `docker compose logs --tail=200 app` — look for `bot.catch` errors and
   `GrammyError` descriptions.
2. Check `TELEGRAM_BOT_TOKEN` is set (the app still runs without it — it logs
   `Telegram bot disabled`).
3. Webhook mode: `TELEGRAM_WEBHOOK_SECRET` must be non-empty, otherwise the route
   is not registered at all. Telegram's `getWebhookInfo` should show a small
   `pending_update_count`.
4. Long polling: only one process may poll a token. If a second instance polls,
   one of them silently starves.
5. `/health` must be `ok`; a `degraded` database stops every handler early.

### Assignment fails with "PBX unavailable"

1. `npm run probe` — does authentication still work? A rotated client secret or a
   changed scope shows up here.
2. `select * from freepbx_sync_jobs where status <> 'DONE' order by created_at desc limit 10;`
3. Numbers are **not** lost: the reservation is rolled back and the audit row
   says `NUMBER_ASSIGNMENT_FAILED`. Users can retry immediately.
4. If the PBX is down for a longer period, consider
   `UPDATE admin_settings ...` nothing — assignment simply refuses, which is the
   intended behaviour (no partial provisioning).

### A number shows ASSIGNED but calls do not arrive

1. `npm run reconcile` — a missing inbound route is recreated automatically.
2. If the finding says `EXTENSION_MISSING_IN_PBX`, the extension was removed on
   the PBX. This is **never** auto-fixed: decide with the operator whether to
   recreate it (admin panel → 👥 Users → Reprovision), release the number, or reassign
   it. Then resolve the finding.
3. If the finding says `ROUTE_DESTINATION_MISMATCH`, the reconciler re-points it
   automatically and the finding disappears on the next run.
4. Check the trunk actually delivers the DID in the pattern the route matches:
   `select did_match_pattern from inbound_route_mappings where number_id = '<id>';`
   and compare with `didCandidates('+<number>')`.

### Users report "no numbers available"

```sql
SELECT status, count(*) FROM numbers GROUP BY status;
SELECT c.name, s.name, count(*) FILTER (WHERE n.status = 'AVAILABLE') AS available
  FROM numbers n JOIN countries c ON c.id = n.country_id JOIN services s ON s.id = n.service_id
 GROUP BY 1,2 ORDER BY available;
```

Import more (**🛠 Admin Panel** → 🔢 Numbers → CSV import) or enable an offer
(**🛠 Admin Panel** → 🧩 Services). Reservations stuck by a crash are cleared by the next
reconciliation run (`releaseStaleReservations`).

### Suspicious referrals

```
Admin panel → 🤝 Referrals → pending commissions
```
Reject with a reason (`REFERRAL_REJECTED` audit row) or mark paid. The daily cap
(`referral.max_per_referrer_per_day`) and the 72-hour hold
(`referral.hold_hours`) are the first line of defence; both are settings, not
code.

### Database backup / restore

See `docs/06-deployment.md` §8. After a restore: `npm run reconcile`, then check
`verifyAuditChain()` in **🛠 Admin Panel** → Health.

## 3. Investigations: "what happened to this number?"

Every state change is in `audit_logs`. The single most useful query:

```sql
SELECT created_at, action, result, actor_type, actor_telegram_id, reason, metadata
  FROM audit_logs
 WHERE target_ref = '<DID or extension>'
    OR target_id = '<number uuid>'
 ORDER BY id;
```

Across time, the assignment history is explicit:

```sql
SELECT a.id, a.status, a.assigned_at, a.released_at, a.release_reason, u.username
  FROM number_assignments a LEFT JOIN users u ON u.id = a.user_id
 WHERE a.number_id = '<number uuid>' ORDER BY a.assigned_at DESC;
```

Route history (including removed routes — rows are kept on purpose):

```sql
SELECT id, freepbx_route_id, destination_extension, status, drift_state,
       created_at, last_applied_at, last_verify_at, deleted_at
  FROM inbound_route_mappings WHERE number_id = '<number uuid>' ORDER BY created_at DESC;
```

Who read a SIP password:

```sql
SELECT created_at, actor_id, actor_telegram_id, reason
  FROM audit_logs WHERE action = 'SIP_PASSWORD_VIEWED' ORDER BY id DESC LIMIT 20;
```

## 4. Common admin tasks

| Task | Where |
|---|---|
| Add DIDs in bulk | Telegram **🛠 Admin Panel** → 🔢 Numbers → CSV import, or `POST /api/admin/numbers/import` |
| Add a country/service/plan pricing | **🛠 Admin Panel** → 🌍 Countries / `🧩 Services`; plans via the API (`POST /api/admin/plans`) |
| Change a business rule | **🛠 Admin Panel** → ⚙️ Settings (audited, no redeploy) |
| Reprovision a SIP account for a user | **🛠 Admin Panel** → 👥 Users → the user → Reprovision (allocates a fresh extension/password) |
| Force a CDR sync | `POST /api/admin/calls/sync` or wait for the 120 s worker |
| Run reconciliation now | **🛠 Admin Panel** → 🔁 Reconciliation → Run now, or `npm run reconcile` |
| Broadcast to users | **🛠 Admin Panel** → 📢 Broadcast (queued through `notifications`, deduped) |
| Purge old sessions | `POST /api/admin/maintenance/purge-sessions` (also runs on boot) |

## 5. Capacity and housekeeping

* `bot_sessions`: purged on boot and by the maintenance endpoint (30 days).
* `notifications`: the worker deletes sent rows older than 30 days.
* `call_history`: grows with traffic; partition or archive annually if the PBX
  produces more than a few million CDRs (the table is append-mostly and keyed by
  `calldate`).
* `pbx_inventory_snapshot`: replaced on every reconciliation run — no growth.
* `audit_logs`: never pruned automatically by design; archive to cold storage if
  required by retention policy, then verify the chain before and after moving
  rows (moving rows breaks `verifyAuditChain()` — export, do not delete).

## 6. Log and metric cheatsheet

| Signal | Meaning |
|---|---|
| `NUMBER_ASSIGNMENT_FAILED` audit row | assignment rolled back; the number is available again |
| `ROUTE_RECREATE_FAILED` finding | reconciler could not restore a route → PBX problem |
| `BACK_TO_MENU`/session noise at debug | normal |
| `freepbx_latency_ms` climbing | PBX or network degradation — check `FREEPBX_TIMEOUT_MS` |
| `reconciliation_open_findings` > 0 (CRITICAL) | operators were alerted in Telegram; resolve after acting |
| `oauth_failures_total` climbing | wrong scope, rotated secret, or clock skew |
| `worker_heartbeats.last_success_at` stale | the worker process is down or blocked |

## 7. Change management

* Behaviour change → `admin_settings` (audited, instant).
* Schema change → a new migration file (never edit an applied one), then
  `npm run migrate`; the runner is checksum-verified.
* Code change → CI (typecheck + 156 tests + docker build), then deploy with
  `npm run migrate && npm run probe && npm run smoke`.
* PBX change (upgrade, new module) → `npm run probe` before enabling traffic;
  a missing operation is a blocker, not a warning.

* 2026-10-08 incident note: this PBX build answers `inboundRoute(id:)` for a
  DELETED route with a GraphQL "Internal server error" instead of null. Route
  verification therefore decides existence by `allInboundRoutes` membership;
  a by-id failure is UNAVAILABLE (reported, never auto-acted on). Orphaned
  routes (owner/deployment gone) are reported ROUTE_STALE_ORPHANED and are
  never auto-recreated. Findings alerts are deduped per findings-signature
  (re-bucketed twice daily). Tooling: `npx tsx scripts/release-orphans.ts`
  releases numbers still attached to deleted users.
