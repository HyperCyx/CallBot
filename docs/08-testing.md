# Testing

```
npm run test:db          # create the test database if missing
npm test                 # 156 tests, real PostgreSQL, ~16 s
npm run typecheck        # strict TypeScript, 0 errors expected
npm run smoke            # end-to-end journey through a running API
```

## 1. Why the tests need a real database

The guarantees this platform sells are PostgreSQL features:

* `SELECT … FOR UPDATE SKIP LOCKED` for the assignment race;
* a partial unique index (`uq_number_assignments_active`) as the last line of
  defence against double assignment;
* `pg_advisory_xact_lock` for extension allocation and referral crediting;
* triggers for the append-only, hash-chained audit log;
* `SET session_replication_role` to truncate append-only tables in the harness.

An in-memory fake would test a different system. The suite therefore connects to
`sipbot_test` (`TEST_DATABASE_URL`), applies the real migrations through the real
runner, and truncates between tests.

## 2. Test harness

`tests/setup.ts`

* **preflight** — fails with copy-paste instructions if the database is missing;
* `runMigrations()` once per run;
* **per-test isolation** — every domain table is truncated with
  `SET session_replication_role = replica` (the audit trigger would otherwise
  block `TRUNCATE`);
* **re-seeding** — `seed_admin_settings()`/`seed_system_roles()` from the
  database's own `setting_defaults` snapshot (never duplicated in TypeScript)
  plus a minimal catalogue (AE + WhatsApp + free/premium plans);
* a **fresh `MockFreePBXClient`** per test so fault injection cannot leak.

`tests/helpers.ts` — factories and assertions helpers: `createUser`,
`createSipAccount`, `addNumbersToInventory`, `getNumberRow`,
`getRouteForNumber`, `countActiveAssignments`, `auditActions`, `mockPbx()`.

`vitest.config.ts` — real Postgres, `singleFork`, `fileParallelism: false`
(the suites share one database), mock PBX, AMI off, `LOG_LEVEL=silent`.

## 3. Suites

| File | Tests | What it proves |
|---|---|---|
| `tests/assignment.test.ts` | 28 | **The spec's §39 race**: one available number, two users, `Promise.allSettled` → exactly one succeeds, the other gets `NO_INVENTORY`; the raw-SQL double insert is rejected by the partial unique index; PBX failure leaves the number AVAILABLE with a `NUMBER_ASSIGNMENT_FAILED` audit row and the retry succeeds; plan limit; blocked user; release/suspend/unsuspend/reassign; double release; `NOT_FOUND` on route delete treated as success; concurrent provisioning allocates unique extensions; password rotation; credential access control; **taking another number** - with `replaceOldest` the new number is assigned and the oldest held one returns to inventory (route removed, assignment closed, audited); a failed assignment never costs the user the number they already had; without the flag a full plan still answers `PLAN_LIMIT`; **extension recycling** - deleting an account frees its extension so the next user can be provisioned with it (migration 013: the unique index is partial, `WHERE deleted_at IS NULL`), and a second live row for a held extension is still rejected; **PBX-aware allocation** - an extension the PBX already owns (hand-made in the GUI, or left by an interrupted job) is skipped and the next candidate is used, a candidate the PBX reports as `already in use` is retried on the next number without half-writing anything, and a range with every candidate taken fails with `NO_INVENTORY` |
| `tests/referral.test.ts` | 12 | Attribution happens once at registration; re-attribution is impossible; a deleted account's code stops working; unknown codes do not break registration; qualification follows the configured rule; commission snapshotted; daily cap; programme switch; reject is permanent; payout moves referral → PAID |
| `tests/api.test.ts` | 27 | Health/metrics shapes; API-key auth (missing/wrong/correct); `Idempotency-Key` replays the response and runs the import once (a retry while the first call is in flight gets `409 CONFLICT`); actor attribution required; error envelope for 400/404/401; approve → extension provisioned; **deleting an account removes the number it held** — released to `AVAILABLE`, assignment closed, inbound route `REMOVED`, PBX extension deleted, account soft-deleted, `NUMBER_RELEASED` / `SIP_ACCOUNT_DELETED` / `USER_DELETED` audited; bulk inventory removal and catalog removal (409 while a number is in use unless the caller passes `force`, which revokes the held numbers from their users - routes removed, holders notified - and orphan routes queued for PBX cleanup); re-adding a removed country revives its row instead of failing on the unique ISO2 (a live duplicate is still a friendly 409); secrets never in list payloads; the admin's approval-request DM carries ✅ Approve / ❌ Reject buttons (malformed payloads send without buttons); the approval DM carries SIP ID, password and host to the owner (and only the fallback notification is persisted, password-free) |
| `tests/unit.test.ts` | 42 | Phone normalisation and DID candidates; AES-GCM round-trip, fresh IVs, tamper rejection; constant-time compare; error taxonomy; sliding window (with fake timers); CSV parsing; audit scrubbing; **schema drift** (a field the PBX calls missing is stripped and remembered, arguments are never touched, a parent whose selection would empty is dropped) and **live-schema mutation inputs** (values are coerced to the declared scalar, `maxContacts` is sent as the string the build expects, documented `outboundCID` is written as the build's `outboundCid`, unknown keys are dropped, `umEnable` is never sent implicitly, and a PBX-generated secret is reported instead of the one we asked for) |
| `tests/reconcile.test.ts` | 14 | Missing route auto-recreated; drifted destination re-pointed; stale reservation released; second run is a no-op; a foreign route is never deleted; a vanished extension is reported, not recreated; findings list/resolve; run bookkeeping; PBX outage marks the run FAILED and changes nothing |
| `tests/bot.test.ts` | 19 | Bot UX invariants, driven through real updates with a stubbed Telegram API: an operator id (`TELEGRAM_SUPER_ADMIN_IDS` or an admin role) is activated on `/start` with SIP provisioned and never sees "pending", while an ordinary applicant still waits; Back walks the stack (Settings → Admin Panel → Main Menu) and is a no-op at the root (transient screens are not mistaken for stack levels); the Get Number flow walks back without looping; mutating callbacks are never replayable; every reachable screen offers `⬅️ Back` / `🏠 Main Menu` / `🛠 Admin Panel`; the ☎️ Get Number flow assigns a real number the moment a service is tapped (and, with `numbers.require_confirmation` switched on, shows the ☎️ Get Number → country → service → **✅ Assign number** confirmation that assigns the same number); a **deleted account re-registers** instead of dying on the unique telegram key (revived PENDING, referral code kept), and two concurrent /start taps create exactly one account, and taking another number **replaces** the old one automatically (the confirmation names it; the replaced number is back in inventory with its route closed) (the country is carried in the session, not in the button); callback-data guard: oversized/non-ASCII payloads are detected, only the offending button is dropped, and a sweep over the Get Number + wizard screens produces **zero** `telegram_invalid_callback_data_total` increments |
| `tests/nav-removal.test.ts` | 7 | **Reported from live use: "clicking back after removing a country does nothing."** Drives the real bot through every removal — country, service, number, bulk inventory wipe, account deletion — and asserts Back always renders a screen and lands one level up; a screen whose entity was deleted behind the admin's back is skipped rather than re-dispatched; deleting an account releases the number it held (asserted in the database); a country whose number a user holds is no longer blocked - the panel shows what removal will revoke and the removal revokes it (holder notified, number retired). |
| `tests/audit.test.ts` | 7 | Append-only triggers raise on UPDATE/DELETE; the chain verifies; a rewrite with triggers disabled is detected (including `reason`, migration 011); filtering; secrets redacted; cyclic metadata cannot hang the scrubber |

Total: **156 tests**.

## 4. Writing a new test

```ts
import { describe, expect, it } from 'vitest';
import { addNumbersToInventory, createSipAccount, createUser, getCountryId, getServiceId, mockPbx } from './helpers.js';
import { assignNumber } from '../src/services/assignment.service.js';

describe('my behaviour', () => {
  it('does the thing', async () => {
    const user = await createUser();
    await createSipAccount(user.id, '10042');          // unique extension per test
    await addNumbersToInventory({ count: 2 });
    mockPbx().failNextOperation('addInboundRoute', 1, 'trunk down', 'NETWORK');

    const result = await assignNumber({ userId: user.id, countryId: await getCountryId(), serviceId: await getServiceId() });
    expect(result.phoneNumber).toMatch(/^\+971/);
  });
});
```

Rules that keep the suite honest:

* never call `setFreePBX()` yourself — `beforeEach` installs the mock;
* give each test a distinct extension (the pool is unique);
* assert on **error codes** (`rejects.toMatchObject({ code: 'PLAN_LIMIT' })`),
  not on message text;
* assert on persisted state (SQL) rather than on return values alone when the
  behaviour is "the database is the source of truth";
* injected PBX faults: `failNextOperation('<graphqlOperationName>', times, msg, kind)` —
  names are the documented operations (`addInboundRoute`, `fetchAllExtensions`, …).

## 5. End-to-end smoke test

`npm run smoke` drives a **running deployment** through the real HTTP API:
health → configuration present → operator account → inventory → applicant →
approval + extension → assignment + inbound route → DID pattern → credentials →
audit trail → release → cleanup. It prints a checklist and exits non-zero on
failure, so it can gate a deploy.

Against a live PBX it performs read-only checks unless `--live` is passed, so it
can be run at any time without side effects.

## 6. CI

`.github/workflows/ci.yml` runs three jobs:

1. **typecheck** — strict TypeScript, no database;
2. **test** — PostgreSQL 17 service container, the full suite, plus migration and
   seed idempotency (`npm run migrate && npm run migrate`, `npm run seed && npm run seed`);
3. **docker** — `docker compose config` lint and an image build.

## 7. Manual verification after a PBX change

```bash
npm run probe             # every required operation present?
npm run reconcile         # is the database still consistent with the PBX?
npm run smoke -- --live   # full journey against the real PBX
```

Then check the admin panel's Health screen and clear any open findings.
