# Security checklist

Answers are about **this codebase**, with the file that implements the control.
Anything not implemented is marked as a residual risk with the compensating
control.

## 1. Secrets and credentials

| # | Control | Status | Where |
|---|---|---|---|
| 1 | No secrets in the repository or in image layers | ✅ | `.env` is git-ignored; `.dockerignore` excludes it; only `.env.example` ships |
| 2 | Secrets come from the environment / secret manager | ✅ | `src/config/env.ts` (zod-validated, fails fast in production) |
| 3 | SIP passwords encrypted at rest (AES-256-GCM, per-record IV, auth tag) | ✅ | `src/lib/crypto.ts`, `sip_accounts.password_encrypted` (`v1:iv:tag:ct`) |
| 4 | Key-encryption key never stored in the database | ✅ | `SECRETS_KEK_BASE64`, required in production |
| 5 | Secrets never logged | ✅ | pino redaction (`authorization`, `password`, `token`, `secret`, …) + `scrubMetadata()` dumps `[REDACTED]` |
| 6 | Secrets never in audit metadata | ✅ | `writeAudit()` scrubs recursively before insert |
| 7 | Secrets never returned by list endpoints | ✅ | asserted by `tests/api.test.ts` ("never exposes a SIP password") |
| 8 | OAuth tokens kept in memory only, never persisted | ✅ | `src/freepbx/oauth.ts` |
| 9 | Credential reads are attributed and audited | ✅ | `revealCredentials()` writes `SIP_PASSWORD_VIEWED` and requires an actor or the owner |
| 10 | SIP passwords are strong and channel-safe | ✅ | `generateSipPassword()` (no `0/O/1/l/I`, no shell-hostile characters) |

## 2. Access control

| # | Control | Status | Where |
|---|---|---|---|
| 11 | Admin actions require a role or the super-admin allowlist | ✅ | `requireAdmin`/`requireSuperAdmin` guards in `src/bot/index.ts`, `resolveRole()` |
| 12 | Banned/deleted users cannot act | ✅ | updates are dropped in the identity middleware, before any handler |
| 13 | Users can only see their own numbers, calls, credentials | ✅ | service calls are always scoped by `userId` (e.g. `getUserCallHistory(userId)`) |
| 14 | Internal API key required on `/api/*`, compared in constant time | ✅ | `safeEqual()` in `src/lib/crypto.ts` |
| 15 | Optional IP allowlist (CIDR) for the admin API | ✅ | `API_IP_ALLOWLIST`, `ipAllowed()` |
| 16 | Telegram webhook signed with a secret token | ✅ | `x-telegram-bot-api-secret-token`; unset secret → webhook disabled (polling used) |
| 17 | Role changes and deletions are audited | ✅ | `USER_ROLE_GRANTED`/`USER_ROLE_REVOKED`/`USER_DELETED` |

## 3. Integrity of business operations

| # | Control | Status | Where |
|---|---|---|---|
| 18 | A number can never be assigned twice (concurrency-safe) | ✅ | `SELECT … FOR UPDATE SKIP LOCKED` + partial unique index `uq_number_assignments_active`; raced in `tests/assignment.test.ts` |
| 19 | Assignment is atomic; failures leave no partial state | ✅ | reserve → PBX → commit with compensating rollback; `NUMBER_ASSIGNMENT_FAILED` audit + recovery sweeper |
| 20 | Plan limits and account status enforced under a user row lock | ✅ | `assignNumber()` locks the user row before counting |
| 21 | Mutating API calls are idempotent | ✅ | `idempotency_keys` (key + scope + request hash, response replay) |
| 22 | PBX mutations are never auto-retried after a timeout | ✅ | `src/freepbx/http.ts` retries only connection-level errors; the reconciler verifies the rest |
| 23 | Reconciliation never performs destructive changes | ✅ | additive fixes only; stale routes and missing extensions become findings (`tests/reconcile.test.ts`) |
| 24 | Referral credit is unambiguous and self-referrals are impossible | ✅ | `referrals.referred_user_id` UNIQUE, `CHECK (referrer <> referred)`, application guard |
| 25 | Commissions cannot be paid twice or rewritten by config changes | ✅ | UNIQUE `(referral_id, source)`, snapshotted `rate_value`/`base_amount_cents` |
| 26 | Expiry never silently destroys a user's number | ✅ | `numbers.auto_release_on_expiry` defaults to false → suspend + flag |

## 4. Audit and traceability

| # | Control | Status | Where |
|---|---|---|---|
| 27 | Every state change writes an audit row | ✅ | `writeAudit()` in services (`NUMBER_ASSIGNED`, `SIP_ACCOUNT_CREATED`, `SETTING_UPDATED`, …) |
| 28 | Audit log is append-only | ✅ | `trg_audit_no_update` / `trg_audit_no_delete` raise on UPDATE/DELETE |
| 29 | Audit log is tamper-evident | ✅ | SHA-256 hash chain (`prev_hash`/`row_hash`), `reason` included since migration 011, `verifyAuditChain()` detects rewrites |
| 30 | Concurrent audit inserts cannot fork the chain | ✅ | advisory lock trigger (`migrations/011_audit_chain_reason.sql`) |
| 31 | Requests are correlatable end to end | ✅ | request id in logs, API responses and audit rows |
| 32 | Failures are classified, not swallowed | ✅ | `AppError` taxonomy + `bot.catch` boundary |

## 5. Input handling and abuse resistance

| # | Control | Status | Where |
|---|---|---|---|
| 33 | All user input parsed/validated before use | ✅ | zod at the API boundary; phone/extension validators; callback ids regex-validated |
| 34 | SQL injection impossible | ✅ | parameterised queries only, no string-built SQL with user data |
| 35 | CAPTCHA before an operator is bothered | ✅ | `bot.captcha_enabled`, attempt limit `security.max_captcha_attempts` |
| 36 | Per-user sliding-window rate limits | ✅ | `src/lib/rate-limit.ts`, limits from `admin_settings` |
| 37 | CSV import bounded and validated | ✅ | ≤ 5000 rows, E.164 normalisation, dial-code match, dedupe, refusal on inactive catalog rows |
| 38 | No OTP interception, code harvesting, spoofing or spam capability | ✅ | not implemented anywhere; the platform only manages endpoints the operator owns |
| 39 | Error messages never leak internals to users | ✅ | `AppError.userMessage` is the only string rendered to Telegram |

## 6. Transport, deployment and operations

| # | Control | Status | Where |
|---|---|---|---|
| 40 | TLS in front of the API, enforced in production | ✅ | `security.enforce_https_only`; nginx example in `docs/06-deployment.md` |
| 41 | Runs as a non-root user in a minimal image | ✅ | `Dockerfile` (`USER node`, alpine) |
| 42 | Graceful shutdown (no half-finished writes on SIGTERM) | ✅ | `tini` + SIGTERM handler in `src/index.ts` |
| 43 | PBX TLS verification on by default | ✅ | `FREEPBX_TLS_VERIFY=true`, `AMI_TLS_VERIFY=true`, optional private CA |
| 44 | Connection pools and statement timeouts bounded | ✅ | `PGPOOL_MAX`, `PG_STATEMENT_TIMEOUT_MS` (a stuck query cannot exhaust the pool) |
| 45 | Health endpoint does not leak secrets | ✅ | returns only status flags, versions and modes |
| 46 | Backups restorable without the KEK risk being hidden | ✅ | documented in `docs/06-deployment.md` §8 |

## 7. Residual risks (accepted, with compensating controls)

| Risk | Why it is accepted | Mitigation |
|---|---|---|
| In-process rate limiter is per-instance | avoids a Redis dependency in a single-node deployment | swap in the Redis implementation when scaling out; documented in `src/lib/rate-limit.ts` |
| A compromised database allows reading encrypted SIP secrets | the KEK lives outside the database, so records stay confidential | rotate passwords (`rotateSipPassword`) and audit `SIP_PASSWORD_VIEWED`; alert on burst reads |
| FreePBX user-level permissions are not modelled | the PBX is the authority for trunk/route validity | API scope is least-privilege; probe verifies only the operations we use |
| AMI is a plaintext protocol unless `AMI_TLS=true` | many deployments keep AMI on localhost | enable `AMI_TLS` for remote PBXs, restrict the AMI user to read/event permissions |
| The audit chain cannot prove *when* a rewrite happened if triggers were disabled | PostgreSQL cannot enforce that without WAL auditing | run with `pgaudit` if regulatory evidence is required; `verifyAuditChain()` still detects the change |
| Telegram is a third-party dependency | inherent to the chosen control surface | the backend keeps working (API + workers) if Telegram is unreachable; updates are retried by Telegram |

## 8. Security review workflow

```bash
npm run typecheck        # strict TS, noUncheckedIndexedAccess
npm test                 # 156 tests incl. concurrency + rollback + audit tamper detection
npm audit --omit=dev     # dependency vulnerabilities
grep -rn "console.log" src | grep -v "// eslint-disable"   # no stray output
```

Before each release: re-run the checks above, re-read this table, and confirm
that no new endpoint was added without a guard.
