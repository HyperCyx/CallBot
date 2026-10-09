# Configuration

Two layers, deliberately separated:

1. **Environment variables** (`.env`) — deployment facts and secrets: database
   URL, bot token, PBX endpoints, encryption keys, ports. Read once at startup
   and validated with zod; production refuses to boot with placeholders or
   missing critical values.
2. **`admin_settings` rows** — every tunable business rule: rate limits, expiry
   windows, commission rates, referral qualification, reconciliation policy,
   feature switches. Editable from the Telegram admin panel, with no redeploy.

If a change would alter *behaviour for users*, it belongs in the database. If it
would alter *where the process talks to or what it authenticates with*, it
belongs in the environment.

## 1. Required environment variables

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | always | `postgres://user:pass@host:5432/db` |
| `API_KEY` | always | ≥ 8 chars, shared secret for `/api/*` |
| `SIGNING_KEY` | always | ≥ 8 chars, HMAC key for internal tokens |
| `TELEGRAM_BOT_TOKEN` | production | from @BotFather; empty = bot disabled, API/workers still run |
| `SECRETS_KEK_BASE64` | production | `openssl rand -base64 32`; encrypts SIP secrets at rest |
| `FREEPBX_BASE_URL`, `FREEPBX_CLIENT_ID`, `FREEPBX_CLIENT_SECRET`, `FREEPBX_TOKEN_URL`, `FREEPBX_GRAPHQL_URL` | production with `FREEPBX_MODE=graphql` | copied from the PBX's API Applications / API URL List pages |

Full annotated list: `.env.example` (every variable the code reads).

## 2. Operational variables (selection)

| Variable | Default | Meaning |
|---|---|---|
| `API_HOST` / `API_PORT` | `0.0.0.0` / `8080` | HTTP listener |
| `API_IP_ALLOWLIST` | empty (allow all) | CIDR list for the admin API |
| `API_RATE_LIMIT_PER_MIN` | `120` | per-IP request ceiling |
| `PGPOOL_MAX` | `15` | connection pool size |
| `PG_STATEMENT_TIMEOUT_MS` | `8000` | per-statement timeout (protects the pool) |
| `TELEGRAM_SUPER_ADMIN_IDS` | empty | bootstrap super admins (comma separated ids) |
| `TELEGRAM_WEBHOOK_SECRET` / `TELEGRAM_WEBHOOK_URL` | empty | when set, webhook mode; otherwise long polling |
| `TELEGRAM_REQUIRED_CHANNEL` | empty | legacy single-channel gate; used only when `bot.required_chats` is empty |
| `TELEGRAM_API_ID` / `TELEGRAM_API_HASH` | operator app 37713990 | MTProto user-app creds (my.telegram.org) - power the membership sweep |
| `userbot.session` (setting) | via `scripts/userbot-login.ts` | one-time operator phone login; stored in DB, drives hourly sweep of every `bot.required_chats` chat: accounts that left get `membership_ok=false` and re-face the gate on next /start |
| `SUPPORT_USERNAME` | empty | shown on the support screen |
| `FREEPBX_MODE` | `mock` | `graphql` for a real PBX, `mock` for development/tests |
| `FREEPBX_ROUTE_DESTINATION_TEMPLATE` | `from-did-direct,{ext},1` | documented FreePBX destination string |
| `DID_NORMALIZE_STRIP_PLUS` / `DID_PREFIX` | `true` / empty | how your trunk delivers DIDs |
| `EXTENSION_RANGE_START` / `_END` | `10000` / `19999` | extension pool |
| `AMI_ENABLED` | `false` | live calls; off = live views report "unavailable" |
| `RECONCILE_INTERVAL_MS` | `300000` | reconciliation cadence |
| `EXPIRY_SWEEP_INTERVAL_MS` | `900000` | expiry sweep cadence |
| `EXPIRY_NOTICE_DAYS` | `3,1` | reminder offsets |
| `LOG_LEVEL` / `LOG_PRETTY` | `info` / `false` | pino settings (redaction always on) |

## 3. Database-backed settings (`admin_settings`)

| Key | Default | Effect |
|---|---|---|
| `bot.registration_enabled` | true | `/start` shows a closed notice when false |
| `bot.captcha_enabled` | true | arithmetic CAPTCHA before the application |
| `bot.require_channel_membership` | **true** | gate registration on membership of every required chat |
| `bot.required_chats` | channel `-1002066974831` (@ai_unbox) + group `-1002205812723` | JSON list of `{chatId,title,url,kind}`; user must join ALL before the captcha (migration 018, operator order 2026-10-08). Bot must be admin of each chat |
| `bot.auto_approve` | false | **dangerous**: approve + provision without an admin |
| `test_number.enabled` / `test_number.value` | true / empty | the shared test DID shown after approval |
| `numbers.max_requests_per_minute` | 5 | Get Number rate limit per user |
| `numbers.require_confirmation` | true | confirm before assigning |
| `numbers.allow_user_release` | true | users may release their own numbers |
| `numbers.auto_release_on_expiry` | false | false = suspend + flag, admin releases |
| `referral.enabled` | true | master switch |
| `referral.commission_type` / `_value` | PERCENTAGE / 10 | FIXED or PERCENTAGE |
| `referral.qualification_rule` | FIRST_NUMBER_ASSIGNED | SIGNUP / USER_APPROVED / FIRST_NUMBER_ASSIGNED / PLAN_PURCHASED |
| `referral.max_per_referrer_per_day` | 20 | daily cap per referrer (anti-abuse) |
| `referral.hold_hours` | 72 | how long a commission stays PENDING before payout |
| `referral.currency` | USD | commission currency |
| `calls.history_page_size` | 10 | rows per page in the bot |
| `calls.show_recording_links` | false | reveal recording paths to users |
| `security.max_captcha_attempts` | 3 | attempts before temporary rejection |
| `security.enforce_https_only` | true | refuses to start the API without TLS termination in front (production) |
| `reconcile.auto_fix_safe` | true | auto-fix additive drift (missing/incorrect routes) |
| `reconcile.alert_admins` | true | Telegram alert on CRITICAL findings |
| `reconcile.lookback_hours` | 24 | CDR rescan window |

Editing:

```
Telegram:  🛠 Admin Panel → ⚙️ Settings → <key> → new value
HTTP:      PATCH /api/admin/settings/<key>   { "value": 10, "actorId": "<uuid>" }
SQL:       UPDATE admin_settings SET value = '10'::jsonb WHERE key = 'numbers.max_requests_per_minute';
```

Values are validated against their declared `value_type`; every change writes a
`SETTING_UPDATED` audit row with the actor and the old/new value.

## 4. Secrets hygiene

* SIP passwords: generated with `crypto.randomInt`, encrypted at rest with
  AES-256-GCM (`v1:iv:tag:ciphertext`), never logged, never in audit metadata,
  never returned in list endpoints.
* The KEK (`SECRETS_KEK_BASE64`) exists only in the environment/secret manager.
  **Losing it means the stored SIP secrets cannot be decrypted** — rotate by
  provisioning new passwords (`rotateSipPassword`), not by editing rows.
* OAuth client secret and access tokens live only in memory; the logger redacts
  `authorization`, `client_secret`, `access_token`, `password`, `token`, `secret`.
* `API_KEY`, `SIGNING_KEY`, `SECRETS_KEK_BASE64` are checked at boot in
  production and must not be the `.env.example` placeholders.

## 5. Rotation checklist

| Secret | Procedure |
|---|---|
| `API_KEY` | set the new value on the app, update callers, restart; old keys stop working immediately |
| `SIGNING_KEY` | rotate during a maintenance window; outstanding signed links are invalidated |
| `SECRETS_KEK_BASE64` | deploy a version that decrypts with the old key and re-encrypts with the new one, then swap the env value; do **not** hand-edit rows |
| Telegram bot token | revoke in @BotFather, set the new token, restart; webhook secret stays valid |
| FreePBX OAuth client | recreate the API application in the PBX, update `FREEPBX_CLIENT_ID`/`_SECRET`, restart |
| AMI user | change on the PBX and in `AMI_SECRET`; the worker reconnects on the next loop |
