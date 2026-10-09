# Telegram bot

Framework: **grammY** (user-selected). Sessions are stored in PostgreSQL
(`bot_sessions`), so a restart never loses a conversation and several instances
can share state.

```
/start → verification (CAPTCHA) → admin approval → SIP extension (FreePBX)
       → test number → Main Menu → Get Number → Country → Service
       → tapping a service assigns the number → SIP details
```

## 1. Middleware order (deliberate, do not reorder)

`src/bot/index.ts`:

1. **request id + logging** — every update gets an id that also lands in audit
   rows and logs;
2. **PostgreSQL session** — `bot_sessions`, keyed by chat+user;
3. **identity / RBAC / ban** — `upsertTelegramAccount()`, `resolveRole()`,
   sets `ctx.state.{user,role,isAdmin,isSuperAdmin}`; updates from banned or
   deleted accounts are **dropped silently** (no error text, no handler run);
4. **per-user rate limits** — sliding window; the Get-Numbers limit comes from
   `numbers.max_requests_per_minute`, support messages are limited to 5/min;
5. **commands** — `/start`, `/menu`, `/help`, `/cancel` (typed `/admin` is
   answered with a pointer to the button, never with a dead end);
6. **callbacks** — every `CB.*` action, with `requireAdmin` /
   `requireSuperAdmin` guards; a navigation recorder (§6) runs after every
   handler and pushes pure-render screens onto the session's back stack;
7. **text router** — dispatches on `session.step` (see below);
8. **documents** — CSV uploads via `getFile` download;
9. **`bot.catch`** — final error boundary; routine `GrammyError`s (e.g. "message
   is not modified") are downgraded to debug so they cannot page anyone.

## 2. User journey

| Step | Screen | Notes |
|---|---|---|
| 1 | `/start` with optional `?start=<referral_code>` | attribution happens **here and only here** |
| 2 | CAPTCHA (simple arithmetic; `bot.captcha_enabled`) | max attempts from `security.max_captcha_attempts`; optional channel membership check |
| 3 | "Application received" | admin gets an inline notification with Approve/Reject |
| 4 | Approved → SIP account provisioned | extension allocated from `EXTENSION_RANGE_*`, secret encrypted, route created |
| 5 | Test number | from settings (`test_number.enabled` / `test_number.value`), never from inventory |
| 6 | **Main Menu** | Get Number · My Numbers · SIP Details · My Calls · Referral · Support |

### Get Number flow

Country list → service list (only offers that have `service_countries.status =
ACTIVE`) → **tapping a service assigns the number immediately** → "Your number"
with SIP details. The service tap *is* the "Assign number" action — that is the
product decision this build starts with. An administrator who wants the
intermediate screen back (price shown, replacement warning, then a dedicated
**✅ Assign number** button) sets `numbers.require_confirmation = 1` in
**⚙️ Settings → numbers**; the switch lives in the database, nothing about the
flow is compiled in.

**Taking another number replaces the old one.** A user whose plan allowance is
already used up is not stopped by a "release a number first" screen: the
confirmation names the number that will go ("taking this number removes +971…
from your account automatically — no need to release it yourself") and on
confirmation the **new number is assigned first**, then the oldest held number
is released (inbound route removed, number returned to inventory, `NUMBER_RELEASED`
audited). That order matters — a failed assignment can never cost the user the
number they already had. `assignNumber({ replaceOldest: true })` implements it
and the API exposes it as `{"replaceOldest": true}`; without the flag a full plan
still answers `PLAN_LIMIT`.

Failure messages are generated from the error taxonomy, so a user sees exactly
one of: *no inventory for this selection*, *your plan limit is reached*, *your
account is not active*, *the PBX is temporarily unavailable* — never a stack
trace or an internal id.

### Pending approval

A PENDING applicant sees only the waiting screen — never the action menu:

> ✅ Captcha Solved! (when a captcha was completed)
> 📋 Request sent to admin.
> ⏳ Please wait for approval...
> You will be notified when approved.
> [🔄 Check approval status]

The refresh button re-renders /start; once the admin approves, the next tap
lands on the real main menu.

### Approval request DM (admin)

The "👤 New user request" alert delivered to every admin carries **✅ Approve /
❌ Reject** buttons right under it — approving provisions the SIP account and
sends the user their credentials DM; rejecting blocks the applicant. The
buttons route through the same handlers as 👥 Users → Pending, so behaviour,
audit and error handling are identical, and the DM itself updates with the
receipt.

### Approval DM (SIP credentials)

When an administrator approves an account, the user receives their credentials
in a one-shot DM:

> ✅ Your account has been approved!
> 🔑 SIP ID: 10194
> 🔐 Password: nH7zV2cG&amp;hR5
> 🌐 Host: 161.97.114.202:5060
> 📅 Expires: 2026-08-15
> Use /start to access the bot.

Secrets are **12 digits** (operator-required format): every provisioned extension
and every user-side rotation (`🔄 Rotate password`) generates a fresh 12-character (letters+digits+symbols)
secret, stored AES-256-GCM-encrypted, never logged. The host/port come from
`SIP_HOST`/`SIP_PORT` (falling back to the FreePBX
host:5060). The password is **delivered to its owner only** — it is never
logged and never stored in the notifications table (its home remains the
encrypted `sip_accounts` row); if the DM cannot be delivered the user gets the
password-free USER_APPROVED notification instead and can always re-open the
credentials in **ℹ️ SIP Info**.

### Coming back after account deletion

A user whose account was **deleted by an administrator** can register again with
`/start`: their row is revived as PENDING (approval/blocking/deletion state
cleared, SIP re-provisioned on approval, referral code kept) instead of failing
on the unique telegram id. Two concurrent `/start` taps race safely — exactly
one account is ever created.

### Session steps (text router)

`captcha`, `support_message`, `admin_search_user`, `admin_add_numbers`,
`admin_csv_import`, `admin_broadcast`, `admin_set_setting`, `admin_edit_service`,
`admin_add_service`, `admin_edit_country`, `admin_add_country`,
`deposit_amount`, `deposit_note`, `admin_fund_amount` (wallet flows, §11),
`admin_pm_add_name`, `admin_pm_add_address`, `admin_pm_edit_address` (payment
method CRUD, §11).

Anything else is treated as an out-of-context message and answered with the main
menu hint — no state can leak between conversations.

## 3. Admin panel

Reached through the **🛠 Admin Panel** button in the main menu. There is no
`/admin` command: the button is only rendered for accounts that resolve to an
admin role, so administering the bot looks like a normal user experience for
everyone else. Roles come from `TELEGRAM_SUPER_ADMIN_IDS` (bootstrap allowlist)
or a `user_roles` row.

```
🛠 Admin Panel
├── 📊 Dashboard        users, numbers by status, live calls, calls today, revenue, open findings
├── 👥 Users            search, approve, block/unblock, plan change, role, delete
├── 🔢 Numbers          list/filter, add (bulk text), CSV import, assign, reassign,
│                       suspend/unsuspend, release, delete
├── 🌍 Countries        add/edit/enable
├── 🧩 Services         add/edit/enable/icon
├── 💳 Plans            (read-only in chat — see below)
├── 📞 Live calls       AMI snapshot with per-call detail
├── 🕘 Call history     filterable, CSV export
├── 🤝 Referrals        per-user stats, pending commissions, mark paid, reject
├── 🔁 Reconciliation   run now, findings list, resolve
├── 🩺 Health           DB, FreePBX, AMI, last reconcile, missing operations
└── ⚙️ Settings         every `admin_settings` row, typed editing
```

**Plan creation is intentionally not a chat flow.** It needs validated pricing
fields, so the bot points admins to `POST /api/admin/plans`
(`a:planadd` → "use the API"). Editing existing plans' status/limits is
available in chat.

An operator whose own registration is still `PENDING` also sees the menu (and
therefore the panel button) — provisioning and approving users must not require
approving yourself first.

Every admin action writes an audit row with the acting Telegram id, the target,
the reason where applicable, and the request id — so "who changed the price" is
always answerable.

### Removing things (catalogue, inventory, accounts)

Every removal is confirmed on its own screen first, and every one of them is
possible entirely from the panel — no SQL:

* **number** — refused while it is assigned or still has a live route (the
  screen says so); otherwise the row is retired (`DISABLED` + `deleted_at`).
* **all available numbers** — a preview shows what would go (`available`,
  `kept` for assigned/suspended/reserved) and only `AVAILABLE` rows are
  removed.
* **country / service** — always possible, even while its numbers are in
  users' hands. The preview screen then becomes a warning that says exactly
  what it will take: how many numbers are in use, by how many users, and that
  removing the entry **revokes** them (each number is removed from its holder's
  account, its inbound route deleted, the number retired, and the holder
  notified). Confirming runs the removal with `force`; **🔴 Disable instead**
  stays available for admins who would rather keep the numbers working. All
  remaining numbers and offers of the entry are removed and any leftover PBX
  route id is queued as a `ROUTE_DELETE` job. Without `force` the API still
  answers `409` (no accidental revocation from a script) — see `docs/04`.
* **removed by mistake?** — adding a country/service with the same ISO2/slug
  **revives** the removed row (a removed entry keeps its row for audit purposes,
  so it could not otherwise be added twice). Numbers and offers went with the
  removal, so they are imported again afterwards.
* **account** — deleting a user **removes the number(s) assigned to it**:
  each number is released back to inventory (its inbound route removed first),
  the SIP account and its PBX extension are deleted, and the account is then
  soft-deleted. See `src/services/userDeletion.service.ts` — the panel and
  `DELETE /api/admin/users/:id` share it, so the two can never drift apart.

After any of these, the removed entity's screens are dropped from the nav stack
(§4), so Back can never return to a screen that no longer exists.

## 4. Navigation: one universal back button

Every screen except the root offers **⬅️ Back**. It is not a per-screen link:
`src/bot/nav.ts` keeps a **stack of screens** in the session (`bot_sessions`, so
it survives restarts and is shared between bot instances, depth capped at 25).

| Piece | Behaviour |
|---|---|
| recorder middleware | after any handler, remembers the callback as the **screen the user is looking at** (`lastRendered`) and pushes it onto the stack **only if it is in the `REPLAYABLE` allowlist** — a list of callbacks that can only render a screen (fail closed: anything unknown is treated as an action and never pushed) |
| `nav:back` handler | Back means *"leave the screen I am looking at"*: if that screen is on the stack, it is popped and its parent is **re-dispatched through the normal callback dispatcher**, so Back re-renders with fresh data and its own keyboard; if the user is on a **transient screen** (confirmation, removal preview, "removed" receipt — deliberately kept off the stack because re-dispatching one would repeat a mutation), the stack top already *is* the parent and is re-rendered without skipping a level |
| stale entries | a target whose entity has since been deleted (`a:ctry:`, `a:svc:`, `a:n:`, `a:u:`, … checked against `deleted_at`) is skipped, up to the Main Menu, so Back never lands on a screen that cannot render |
| empty stack | renders the Main Menu — pressing Back on the root is a no-op, never an error |
| `🏠 Main Menu` | clears the stack (the root is the root) |
| After a removal | the destructive admin actions (`a:ctrydelok`, `a:svcdelok`, `a:ndelok`, `a:nwipeok`, user deletion) drop the removed entity's screens from the stack (`dropNavMatching`), so Back can never return to them |

Two properties matter and are covered by tests (`tests/bot.test.ts`) and by the
screen walker (`npx tsx scripts/screens.ts`):

* **Back can never mutate.** Approvals, releases, password rotations and
  assignments are excluded from the allowlist, so re-dispatching is impossible;
  after an action, Back returns to the screen the user acted from.
* **Every screen is escapable.** The walker drives the real handlers with a
  stubbed Telegram API and fails if any rendered screen has none of
  `⬅️ Back` / `🏠 Main Menu` / `🛠 Admin Panel`.
* **Back after a removal always renders.** Removing a country, a service, a
  number, the whole available inventory or an account must never leave a dead
  Back button: covered by `tests/nav-removal.test.ts` (6 tests), which walks
  each removal and presses Back until the Admin Panel.

## 5. Operator accounts are never "pending"

`/start` → CAPTCHA → **approval** is the normal path for an applicant, but the
person running the bot cannot approve their own application from a queue they
are not part of yet. So a Telegram id in `TELEGRAM_SUPER_ADMIN_IDS` (or an
account holding a `super_admin` / `admin` / `support` role) is **activated on
first contact**: `src/bot/handlers/staff.ts` approves the row, provisions the
SIP extension through the same code path as a manual approval, and writes an
`USER_APPROVED` audit row with `reason = "operator bootstrap: …"` and
`metadata.bootstrap = true`, so the audit trail says exactly why the account was
never reviewed. A PBX outage cannot undo the approval: provisioning failure is
reported to the operator and left as a retryable state.

Ordinary applicants are untouched by this rule and still go through review.

## 6. Callback data: the 64-byte rule, enforced

Telegram refuses a message with `BUTTON_DATA_INVALID` (400) when any
`callback_data` is longer than **64 bytes** - and then delivers *nothing*. The
button simply never appears, the screen looks frozen, and nothing shows up in
the bot's own logs unless it says so explicitly.

Two rules follow, and both are enforced in code:

1. **Multi-step flows keep their context in the session.** The Get Number flow
   stores the chosen country in `session.offerCountryId`, so the service buttons
   carry `n:s:<serviceId>` (43 bytes) instead of `n:s:<country>:<service>` (76).
   The admin add-number / CSV wizards use `session.numberWizard`, and the
   assign/reassign candidate lists use `session.assignTarget` for the same
   reason: `nassignok:<number>:<user>` was 84 bytes.
2. **Every outgoing keyboard is checked** (`src/bot/callback-data.ts`, wired as a
   grammY API transformer in `createBot`). An oversized or non-ASCII button is
   logged at `error`, counted in `telegram_invalid_callback_data_total` /
   `telegram_dropped_buttons_total`, and **dropped from the keyboard** so the
   rest of the screen still renders. Alert on those counters: any value above
   zero is a bug.

## 7. Callback surface

Callback data is namespaced and validated before use (regex-validated ids are
parsed, never string-concatenated into SQL):

| Namespace | Example | Purpose |
|---|---|---|
| `m:` | `m:numbers`, `m:getnum`, `m:wallet`, `m:dep` | main menu navigation |
| `dep:` | `dep:m:<methodId>`, `dep:cancel` | pick a payment method / cancel a pending own request |
| `nav:` | `nav:back` | the universal back button |
| `n:s:` | `n:s:<serviceId>` | service picker (country comes from the session) |
| `n:get:` | `n:get:<serviceId>:FREE` | ✅ Assign number (only rendered when the confirmation switch is on) |
| `n:` | `n:info:<id>`, `n:rel:<id>` | actions on an assigned number |
| `a:` | `a:users:u:<id>`, `a:nsuspok:<id>`, `a:csv`, `a:settings`, `a:cmpay:<id>`, `a:deps`, `a:dpok:<id>`, `a:dpno:<id>`, `a:fund:<userId>` | admin actions |
| — | `start:recheck`, `start:cancel`, `noop` | captcha / generic |

`A(pattern, handler)` in `src/bot/index.ts` adapts regex callbacks into
`(ctx, ...groups)` handlers, which keeps the registration list flat and readable.

## 8. Notifications

`notifications` table + the notification worker (20 s):

* assignment success/failure, extension ready, number suspended/released/expired;
* expiry reminders N days ahead (`EXPIRY_NOTICE_DAYS`);
* referral qualified / commission paid;
* admin alerts for CRITICAL reconciliation findings;
* every row has a `dedupe_key` so a retry cannot spam a user.

The worker sends through `bot.api.sendMessage` and marks the row
`sent`/`failed` with an attempt counter; permanent failures (user blocked the bot)
are not retried forever.

## 8b. Wallets, prices and deposits (operator decision 2026-10-08)

**No plans are ever shown in the bot.** What a user sees about money:

* the main menu shows their current 💰 **Balance** (USD) instead of any plan line;
* every row of the country picker ends with either `🆓 Free` or `💎 $X.XX` /
  `💎 from $X.XX` — the exact charge is the number-level price when set,
  otherwise the active country offer's price, otherwise free;
* the **💰 Balance** screen lists the running ledger (last six movements with
  the balance after each one) and shows a ⏳ marker while a deposit request is
  awaiting a decision.

**Paying for a paid country.** The wallet is debited *inside the same database
transaction that reserves the number*: if the balance is short, the transaction
aborts — nothing is deducted and nothing is reserved — and the bot answers with
a "Not enough balance" screen plus a 💳 Deposit button. If the PBX step fails
later (after the charge committed), the rollback path refunds the exact amount
in a single atomic move (`REFUND` ledger row). The success receipt shows the
charge and the new balance.

**Deposits are manual-approval with admin-managed gateways.** 💳 Deposit →
pick a **payment method** (Binance Pay, USDT, anything the admin configured — 🏦
Pay Methods in the admin panel; each method carries the destination
address/details + optional instructions) → type the USD amount
($0.50–$10,000) → the bot shows the **address to pay** → the user sends the
**transaction ID** (mandatory, 4–200 chars) → the request lands in the admin
notifications with method + TXID and inline ✅ `a:dpok:<id>` / ❌ `a:dpno:<id>`
buttons — the same interaction pattern as user approvals. Approving credits the
wallet and updates the request **in one transaction**, so double-tapping ✅ (or
two admins racing) can never credit twice; the buttons on an already-decided
request become a no-op with an explanatory message. One pending request per
user is enforced by a partial unique index, and the user can cancel their own
pending request from the Balance screen. A method disabled mid-flow refuses the
next step cleanly; with no ACTIVE methods the Deposit button says so instead of
showing a dead form.

The admin panel also has a **💳 Deposits** queue (every pending request with its
own ✅/❌ pair) and a **💳 Add Balance** button on each user card (admin funds
the wallet directly from chat; the user is notified instantly and an
`WALLET_ADJUSTED` audit row is written).

## 9. Anti-abuse in the bot layer

* CAPTCHA before an operator ever sees the application;
* sliding-window limits on `Get Number` and support messages;
* referral codes validated once, at registration, with self-referral blocked in
  both the application and the database;
* out-of-context input never advances state;
* flood control comes from the pluggable `RateLimiter` interface (swap the
  in-process implementation for Redis when running multiple instances —
  see `docs/06-deployment.md`).

## 10. What the bot never does

No OTP interception, no verification-code harvesting, no bulk messaging to
non-admins, no caller-ID spoofing, no bypassing third-party platform rules. The
bot provisions and manages endpoints the operator is entitled to operate.
