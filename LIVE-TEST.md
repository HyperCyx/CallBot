# Live test checklist

Your bot instance is running with **long polling**, so it works without a public
URL. Admin Telegram id `1211362365` is in `TELEGRAM_SUPER_ADMIN_IDS`, which means
you are a **super admin from the first message**:

* your account is **never left in "pending approval"** — an operator id is
  activated on the spot, with a SIP extension provisioned in the same breath;
* the **🛠 Admin Panel** button appears in your menu straight away.

There is no `/admin` command — the button is the only route, and it is only
rendered for admin accounts.

**Every screen has a ⬅️ Back button.** Back walks up the way you came in — tap
through several screens (e.g. Main Menu → Admin Panel → Settings), then press
**⬅️ Back** repeatedly and you land back exactly where you came from. It never
re-runs an action. **🏠 Main Menu** jumps straight to the root from anywhere.

## What is real vs simulated in this run

| Component | State | Effect on testing |
|---|---|---|
| Telegram bot | **real** | every screen, button, session and notification works exactly as in production |
| PostgreSQL 17 | **real** | your user, numbers, assignment, audit rows are all really written |
| FreePBX | **mock** (`FREEPBX_MODE=mock`) | extensions and inbound routes are created in an in-memory PBX: you see real provisioning flows, extension numbers, route ids and audit rows, but no SIP traffic leaves the sandbox |
| AMI / live calls | **off** (`AMI_ENABLED=false`) | "Live calls" correctly reports unavailable; CDR history is empty |
| Inventory | 112 demo DIDs | 7 countries × 4 services × FREE + PREMIUM |

So: flow, state machine, limits, audit and admin panel are all testable. Real
SIP registration/audio would need `FREEPBX_MODE=graphql` plus PBX credentials
(`docs/06-deployment.md` §5).

## 1. Registration (the spec's user journey)

1. Send **/start**.
2. Answer the CAPTCHA (arithmetic; reply with just the number).
3. Expect: **"✅ Operator account activated"** with your **SIP ID** — no
   pending screen, no manual approval, because you are the operator id. The
   Main Menu follows immediately, with the **🛠 Admin Panel** button.

*(An ordinary applicant still goes to `PENDING` and still gets reviewed by an
admin — the shortcut applies to `TELEGRAM_SUPER_ADMIN_IDS` and to accounts
holding an admin role only.)*

## 2. Admin panel

4. Tap **🛠 Admin Panel** → **👥 Users**: your row is already **ACTIVE** and
   holds a SIP extension.
5. A brand-new applicant (a second Telegram account) shows up under
   **⏳ Pending** → their row → **✅ Approve** provisions them.

## 3. Main menu and number assignment

6. **/menu** → **☎️ Get Number** → country (e.g. 🇦🇪 United Arab Emirates) →
   service (💬 WhatsApp) — **tapping the service assigns the number** (set
   `numbers.require_confirmation = 1` if you want the intermediate
   **✅ Assign number** screen back).
7. Expect: a DID plus SIP details (server, port, ID = extension, password),
   "test number" screen after approval, and an audit row `NUMBER_ASSIGNED`.
8. **📋 My Numbers** → view details → try **🔄 Rotate password** and
   **📋 Copy-friendly text**.

## 4. Things worth trying to break (the important ones)

| Test | Expected |
|---|---|
| **Get Number** twice on the FREE plan (limit = 1) | the second service tap **replaces** your number automatically — no "release it first" screen; My Numbers shows only the new one |
| /start again **after an admin deleted your account** | registration restarts (verification → PENDING → approval) — never a raw database error |
| Tap the same service repeatedly / double-tap it | only one number assigned — the double-assignment guard holds |
| Reload / press **📋 My Numbers** then **♻️ Release** a number | number returns to AVAILABLE, inbound route removed |
| **☎️ Get Number** 6 times in a minute | rate limited ("max requests per minute" = 5) |
| The **👤 New user request** DM | has ✅ Approve / ❌ Reject buttons underneath — tapping them provisions (and DMs credentials) or blocks, and the DM updates on the spot |
| Approve a pending user (🛠 Admin Panel → 👥 Users → ✅ Approve) | the user receives one DM with **SIP ID, password, host and expiry**; the password is not stored in the notifications table |
| **🛠 Admin Panel → ⚙️ Settings** → change `numbers.max_requests_per_minute` to 2 → retry | new limit applies immediately, no restart (configuration is data) |
| **🛠 Admin Panel → 🔁 Reconciliation → Run now** | runs clean: "0 findings" while DB and PBX agree |
| **🛠 Admin Panel → 🩺 Health** | DB ok, FreePBX mock, AMI unavailable, audit chain verified |
| **🛠 Admin Panel → 📊 Dashboard** | your user, the numbers by status, calls today = 0 |
| **🛠 Admin Panel → 🔢 Numbers** → filter AVAILABLE / ASSIGNED | inventory view including the ones you assigned |
| **🛠 Admin Panel → 📡 Live calls** | a clear "AMI not enabled" state, not a stale list |
| **🛠 Admin Panel → 💰 Referrals** | your referral link (`https://t.me/<your_bot>?start=<CODE>`) |
| **⬅️ Back** from any deep screen (Settings, a number, a user, a plan) | returns to the screen you came from — never a dead end |
| Press **⬅️ Back** on the Main Menu | stays on the Main Menu, no error message |
| Walk **Get Number** → country → service | every step renders and the service tap assigns the number (the service list used to fail silently with Telegram's `BUTTON_DATA_INVALID`) |

## 5. Admin actions that change state (all audited)

* **🔢 Numbers → ➕ Add numbers**: paste one number per line.
* **🔢 Numbers → 📥 CSV import**: send a `.csv` document with a `phone_number`
  header and a few DIDs for the country you pick.
* **🌍 Countries / 🧩 Services**: add or disable one, then check that the
  Get Number flow reflects it instantly.
* **👥 Users → block / unblock**: after blocking yourself, further taps are
  refused — remember to unblock.
* **📢 Broadcast**: sends a message to all users (only you right now).
* **⚙️ Settings**: every business rule (referral %, hold hours, expiry policy,
  CAPTCHA, registration switch) is editable here.

## 6. If something looks wrong

Tell me what you tapped and what you saw — the running process logs every
update, service call, PBX call and audit write, so I can read the exact trace.
Reset options:

```bash
# wipe users/numbers/audit and re-seed the catalogue (development only)
sudo -u postgres psql -d sipbot -c "TRUNCATE users, numbers, sip_accounts, number_assignments, inbound_route_mappings, audit_logs, bot_sessions, notifications, referrals, referral_commissions, referral_codes, call_history, call_sessions, extension_allocations CASCADE;"
npx tsx scripts/demo-inventory.ts 4
```

Reload the inventory at any time with `npm run seed -- --force-catalogue`.

## Live calls over AMI (65.181.123.105:5038)

* AMI is enabled in `.env` (`AMI_ENABLED=true`, user `callbot`). The bot self-heals:
  it retries every 5 s (15 s after an auth rejection), marks itself connected only
  after a real Login handshake, keeps the session alive with periodic Ping, and the
  admin health screen shows the exact last connection error.
* 2026-10-08 finding: the perimeter in front of the PBX SYN-ACKs EVERY port
  (verified: closed port 5223 also "opens"), so `connect()` alone proves nothing —
  a 15 s pre-login watchdog now detects silently-dropped paths. During the window
  the device passed genuine AMI traffic and Asterisk answered Login with
  **Authentication failed** for the `callbot` account → credentials/account issue
  on the PBX side. Heavy failed-login bursts also risk fail2ban bans; whitelist the
  bot egress IP (see runbook notes in chat) before re-testing.
* Operator checklist to bring live calls online:
  1. FreePBX GUI → Settings → Asterisk Manager Users → `callbot`: re-type the secret
     exactly, rights read=`call` (events) and write=`command` (CoreShowChannels).
  2. Submit, then **Apply Config** (red button) — without it Asterisk never reloads
     manager.conf and every login is rejected.
  3. Ensure AMI binds a reachable address (`/etc/asterisk/manager.conf` `[general]
     bindaddr=0.0.0.0`, `port=5038`) and the perimeter forwards 5038 to the PBX.
  4. System Admin → Intrusion Detection: whitelist the bot's egress IP (currently `136.66.243.139` — sandbox egress can change when this workspace is recycled; if the bot's HTTP API person check fails after a recycle, re-check it with `curl ifconfig.me` from the workspace).
