# Deployment

## 1. Prerequisites

| Component | Version | Notes |
|---|---|---|
| Node.js | ≥ 20 | ESM, native `fetch` |
| PostgreSQL | 17 | needs `pgcrypto` + `citext` (created by migration 001) |
| FreePBX | 17 with the API module | OAuth2 client-credentials app + scope; AMI user for live calls |
| Reverse proxy | any TLS terminator | nginx/Caddy/Traefik in front of the API |

## 2. First deploy (manual)

```bash
git clone <repo> && cd sipbot
cp .env.example .env
$EDITOR .env                       # DATABASE_URL, API_KEY, SIGNING_KEY,
                                   # TELEGRAM_BOT_TOKEN, SECRETS_KEK_BASE64,
                                   # FREEPBX_* (see docs/05-configuration.md)

npm ci
npm run build                      # or: npm ci --omit=dev and run from dist
npm run migrate                    # apply 001..012 (idempotent, checksum-verified)
npm run seed                       # settings + roles + starter catalogue (idempotent)
npm run probe                      # verify the PBX exposes every required operation

npm start                          # API + bot + in-process workers
npm run start:worker               # optional: worker in its own process
```

Verify before opening the bot to users:

```bash
npm run smoke                      # full journey through the real API (17 checks)
curl -s localhost:8080/health | jq # database/freepbx/ami/version
```

`npm run smoke` is read-only unless FreePBX is in mock mode; against a live PBX
it refuses to write (extension/route creation) unless you pass `--live`.

## 3. Docker Compose

```bash
cp .env.example .env      # set POSTGRES_PASSWORD as well
docker compose up -d --build
docker compose run --rm migrate
docker compose run --rm seed
docker compose logs -f app worker
```

Services: `postgres` (healthchecked, volume `pgdata`), `app` (API + bot,
published on `API_PORT`), `worker` (AMI, CDR, reconciliation, queues), and the
`tools` profile for `migrate`/`seed` one-shots. FreePBX is intentionally not part
of the stack — it is an external system.

The image runs as the `node` user with `tini` as PID 1 so SIGTERM reaches the
graceful shutdown path (drain HTTP, purge sessions, close the pool).

## 4. Reverse proxy and TLS

The API speaks plain HTTP and expects TLS to be terminated in front of it:

```nginx
server {
  listen 443 ssl;
  server_name sipbot.example.com;
  ssl_certificate     /etc/letsencrypt/live/sipbot.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/sipbot.example.com/privkey.pem;

  location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header X-Forwarded-For $remote_addr;   # used by the IP allowlist
    proxy_set_header X-Request-Id $request_id;
    proxy_set_header Host $host;
    proxy_read_timeout 30s;
  }
}
```

* Keep `security.enforce_https_only = true` in production.
* Restrict `/api/*` to the operator network with `API_IP_ALLOWLIST` and/or at the
  proxy — the bot does not need the HTTP API from the public internet.
* Telegram webhook mode needs a public HTTPS URL:
  `TELEGRAM_WEBHOOK_URL=https://sipbot.example.com/telegram/webhook` plus
  `TELEGRAM_WEBHOOK_SECRET` (the handler refuses unsigned calls). Without a public
  URL, leave both empty and the bot uses long polling instead — no inbound
  exposure at all.

## 5. FreePBX side

1. **Admin → API → Applications**: create a *machine-to-machine*
   (client-credentials) application. Copy the client id/secret.
2. **API → API URL List**: copy the Token URL and GraphQL URL into
   `FREEPBX_TOKEN_URL` / `FREEPBX_GRAPHQL_URL`.
3. **API Scope Visualizer**: grant the operations listed in
   `docs/02-freepbx-integration.md` §1 and put the scope string in
   `FREEPBX_SCOPE`. An app that authenticates but does nothing is almost always a
   missing scope.
4. **Settings → Asterisk Manager User**: create a user for AMI with *read/event*
   permissions only; set `AMI_USER`/`AMI_SECRET` and `AMI_ENABLED=true`.
5. Ensure the inbound trunk delivers DIDs in the form your
   `DID_NORMALIZE_STRIP_PLUS`/`DID_PREFIX` settings expect. The reconciler
   compares the pattern recorded in `inbound_route_mappings.did_match_pattern`
   with what the PBX reports, and the possible delivered forms are listed by
   `didCandidates()`.
6. Run `npm run probe` again. Any missing operation is a blocker — fix the scope
   or the module version *before* going live.

## 6. Migrations in CI/CD

Migrations are forward-only and checksum-verified:

* the runner stores `filename`, `checksum`, `applied_at`, `duration_ms`;
* editing an applied file aborts the run with a checksum error → add a new file;
* the app applies pending migrations on boot when
  `RUN_MIGRATIONS_ON_START=true` (compose sets it), so a rolling deploy never
  starts code against an old schema;
* to roll back a bad *release*, roll the code back and add a new migration that
  undoes it — never edit history.

Blueprint:

```yaml
- run: npm ci && npm run build
- run: npm run migrate            # safe to run on every deploy
- run: npm run seed               # settings + roles only; catalogue skipped if populated
- run: npm run probe              # optional gate: fail the deploy on missing operations
- run: docker compose up -d app worker
- run: npm run smoke              # post-deploy verification
```

## 7. Scaling and multiple instances

| Concern | Guidance |
|---|---|
| Bot instances | Multiple app instances can share updates only with webhook mode + a load balancer; with long polling run exactly one |
| Sessions | Already in PostgreSQL — no sticky routing needed |
| Rate limiter | In-process by default; swap `RateLimiter` for the Redis implementation behind the same interface when running several app instances (documented in `src/lib/rate-limit.ts`) |
| Workers | Safe to run several: jobs use `FOR UPDATE SKIP LOCKED`, notifications use `dedupe_key`, referrals use an advisory lock |
| AMI | One AMI connection per worker instance is fine (event streams are independent); use AMI TLS if the PBX is remote |
| Postgres | `PGPOOL_MAX` × instances must stay under the server's `max_connections`; for a busy deployment put PgBouncer in front (transaction pooling) |

## 8. Backups and disaster recovery

```bash
# Logical backup (schema + data)
pg_dump --format=custom --no-owner "$DATABASE_URL" > sipbot-$(date +%F).dump

# Restore
pg_restore --clean --if-exists --no-owner -d "$DATABASE_URL" sipbot-2026-10-07.dump
```

* Back up `SECRETS_KEK_BASE64` **separately from the database**: an encrypted
  backup without the key cannot recover SIP passwords (the restore path then
  requires a password rotation for every account).
* After restoring, run `npm run reconcile`. The reconciler recreates routes that
  exist in the database but not on the PBX (additive fixes) and reports anything
  ambiguous. PBX extensions themselves are never deleted automatically.
* Verify the audit chain after a restore: `verifyAuditChain()` (admin panel →
  Health, or via the API).

## 9. Monitoring

| Signal | Where |
|---|---|
| Liveness / dependency state | `GET /health` (503 when the database is down) |
| Prometheus metrics | `GET /metrics` (`api_requests_total`, `freepbx_latency_ms`, `numbers_available`, `reconciliation_open_findings`, …) |
| Background plane liveness | `worker_heartbeats` (job lag, last reconcile, AMI connect state) |
| Operator-facing status | the admin panel's 🩺 Health screen in Telegram, including the last compatibility report |
| Drift | `reconciliation_findings` (open CRITICAL findings are alerted to admins) |

Suggested alerts: `/health` non-200 for 2 minutes; `reconciliation_open_findings
> 0` with severity CRITICAL; `freepbx_latency_ms` p95 above the PBX timeout;
job queue depth growing for 10 minutes; no CDR sync in `reconcile.lookback_hours`.

## 10. Upgrade checklist

1. Read the new migrations (never edited, only added).
2. Back up the database and confirm you hold `SECRETS_KEK_BASE64`.
3. `npm ci && npm run build && npm test` (156 tests, real PostgreSQL).
4. Deploy during a window when no numbers are being assigned.
5. `npm run migrate` → `npm run probe` → restart app and worker.
6. `npm run smoke` → check the admin panel's Health screen and the reconciliation findings.
7. Roll back by redeploying the previous image plus a new forward migration.
