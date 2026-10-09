import { InlineKeyboard } from 'grammy';
import { NAV_BACK } from './nav.js';
import type { Country, OfferCountry, OfferService, Plan, Service } from '../services/catalog.service.js';
import type { NumberWithCatalog } from '../services/inventory.service.js';
import { formatDate } from '../lib/time.js';

/**
 * Inline keyboards (spec §33: "Use Telegram inline keyboards. Never rely only on
 * typed commands").
 *
 * Every callback payload is namespaced and short (< 64 bytes, Telegram's hard
 * limit). Long values (UUIDs are 36 chars) are used directly but never combined
 * with more than one extra field.
 */

export const CB = {
  MAIN_MENU: 'm:main',
  GET_NUMBER: 'm:get',
  WALLET: 'm:wallet',
  DEPOSIT: 'm:dep',
  DEPOSIT_CONFIRM: 'dep:confirm',
  DEPOSIT_CANCEL_PENDING: 'dep:cancel',
  SIP_INFO: 'm:sip',
  MY_NUMBERS: 'm:nums',
  MY_CALLS: 'm:calls',
  REFERRAL: 'm:ref',
  SUPPORT: 'm:sup',
  INVITE: 'm:inv',
  LIVE_CALLS_USER: 'm:live',
  HELP: 'm:help',
  ADMIN: 'a:home',
  ADMIN_DEPOSITS: 'a:deps',
} as const;

export function mainMenuKeyboard(isAdmin: boolean): InlineKeyboard {
  const kb = new InlineKeyboard()
    .text('☎️ Get Number', CB.GET_NUMBER)
    .text('📋 My Numbers', CB.MY_NUMBERS)
    .row()
    .text('💰 Balance', CB.WALLET)
    .text('ℹ️ SIP Info', CB.SIP_INFO)
    .row()
    .text('📞 My Calls', CB.MY_CALLS)
    .text('🤝 Referral', CB.REFERRAL)
    .row()
    .text('🆘 Support', CB.SUPPORT);
  if (isAdmin) kb.row().text('🛠 Admin Panel', CB.ADMIN);
  return kb;
}

/** Deposit step 1: pick the payment method/gateway the admin configured. */
export function depositMethodKeyboard(methods: { id: string; icon: string | null; name: string }[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const m of methods) kb.text(`${m.icon ?? '💠'} ${m.name}`, `dep:m:${m.id}`).row();
  kb.text('🏠 Main Menu', CB.MAIN_MENU);
  return tk(kb);
}

/** Admin: payment methods management list. */
export function paymentMethodsKeyboard(methods: { id: string; icon: string | null; name: string; status: string }[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const m of methods) {
    kb.text(`${m.icon ?? '💠'} ${m.name} ${m.status === 'ACTIVE' ? '🟢' : '⚫'}`, `a:pm:${m.id}`).row();
  }
  kb.text('➕ Add method', 'a:pmadd').row().text('🛠 Admin Panel', 'a:home');
  return tk(kb);
}

/** Admin: one method's action card. */
export function paymentMethodDetailKeyboard(method: { id: string; status: string }): InlineKeyboard {
  const kb = new InlineKeyboard();
  kb.text('✏️ Edit address/details', `a:pmedit:${method.id}`).row();
  if (method.status === 'ACTIVE') kb.text('🔴 Disable', `a:pmoff:${method.id}`);
  else kb.text('🟢 Enable', `a:pmon:${method.id}`);
  kb.text('🗑 Delete', `a:pmdel:${method.id}`).row();
  kb.text('⬅️ Methods', 'a:pms').text('🛠 Admin', 'a:home');
  return tk(kb);
}

/** Wallet home: balance, ledger, and the single clear action. */
export function walletKeyboard(depositPending: boolean): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (depositPending) kb.text('❌ Cancel pending deposit', CB.DEPOSIT_CANCEL_PENDING).row();
  kb.text('💳 Deposit', CB.DEPOSIT).row().text('🏠 Main Menu', CB.MAIN_MENU).text('⬅️ Back', NAV_BACK);
  return kb;
}

export function depositConfirmKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('✅ Submit request', CB.DEPOSIT_CONFIRM)
    .row()
    .text('🏠 Main Menu', CB.MAIN_MENU)
    .text('⬅️ Back', NAV_BACK);
}

/** After a paid-country tap with too little balance. */
export function insufficientFundsKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text('💳 Deposit', CB.DEPOSIT).row().text('🏠 Main Menu', CB.MAIN_MENU).text('⬅️ Back', NAV_BACK);
}

/**
 * Appends the universal back row.
 *
 * Every screen except the main menu must offer a way back, and the button is
 * always the same one so users only have to learn it once: it pops the
 * navigation stack and re-renders the previous screen (src/bot/nav.ts).
 */
export function withBack(kb: InlineKeyboard): InlineKeyboard {
  return kb.row().text('⬅️ Back', NAV_BACK);
}

export function backToMenuKeyboard(isAdmin = false): InlineKeyboard {
  const kb = new InlineKeyboard().text('🏠 Main Menu', CB.MAIN_MENU);
  if (isAdmin) kb.text('🛠 Admin Panel', CB.ADMIN);
  return tk(kb);
}

/** Small helper so the back row is appended identically everywhere. */
function tk(kb: InlineKeyboard): InlineKeyboard {
  return kb.row().text('⬅️ Back', NAV_BACK);
}

export function backKeyboard(target = CB.MAIN_MENU, label = '⬅️ Back'): InlineKeyboard {
  return new InlineKeyboard().text(label, target);
}

/**
 * A yes/no screen. Every confirmation carries the universal Back as well as
 * Cancel, so "get me out of here" always works the same way (spec §3 UX rule:
 * no screen may be a dead end).
 */
export function confirmKeyboard(confirmData: string, cancelData: string, yesLabel = '✅ Yes', noLabel = '❌ Cancel'): InlineKeyboard {
  return new InlineKeyboard()
    .text(yesLabel, confirmData)
    .text(noLabel, cancelData)
    .row()
    .text('⬅️ Back', NAV_BACK);
}

/** 🇦🇪 United Arab Emirates — the flag comes from the database (spec §8). */
export function countryKeyboard(countries: OfferCountry[], page = 0, pageSize = 8): InlineKeyboard {
  const kb = new InlineKeyboard();
  const slice = countries.slice(page * pageSize, page * pageSize + pageSize);
  for (const country of slice) {
    const priceTag =
    country.min_price_cents && country.min_price_cents > 0
      ? ` 💎 ${country.max_price_cents && country.max_price_cents !== country.min_price_cents ? 'from ' : ''}$${(country.min_price_cents / 100).toFixed(2)}`
      : ' 🆓 Free';
    const label = `${country.flag ?? '🌍'} ${country.name}`;
    kb.text(`${label} (${country.available_count})${priceTag}`, `n:c:${country.id}`).row();
  }

  const pages = Math.ceil(countries.length / pageSize);
  if (pages > 1) {
    if (page > 0) kb.text('⬅️', `n:cp:${page - 1}`);
    kb.text(`${page + 1}/${pages}`, 'noop');
    if (page < pages - 1) kb.text('➡️', `n:cp:${page + 1}`);
    kb.row();
  }
  kb.text('🏠 Main Menu', CB.MAIN_MENU).text('⬅️ Back', NAV_BACK);
  return kb;
}

export function serviceKeyboard(services: OfferService[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const service of services) {
    const price = service.price_cents ? ` · ${(service.price_cents / 100).toFixed(2)} ${service.currency}` : '';
    // Service only: the country comes from the session (`offerCountryId`).
    kb.text(`${service.icon ?? '📱'} ${service.name} (${service.available_count})${price}`, `n:s:${service.id}`).row();
  }
  kb.text('⬅️ Back to countries', 'n:back:countries').row();
  return tk(kb);
}

export function numberConfirmKeyboard(countryId: string, serviceId: string, planType: 'FREE' | 'PREMIUM'): InlineKeyboard {
  // The country is only used for the "up one level" button; the assignment
  // itself reads it from the session.
  return new InlineKeyboard()
    .text('✅ Assign number', `n:get:${serviceId}:${planType}`)
    .row()
    .text('⬅️ Choose another service', `n:back:services:${countryId}`)
    .row()
    .text('⬅️ Back', NAV_BACK);
}

export function myNumbersKeyboard(numbers: NumberWithCatalog[], allowRelease: boolean): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const n of numbers) {
    kb.text(`${n.status === 'SUSPENDED' ? '⚠️' : '📞'} ${n.phone_number}`, `n:info:${n.id}`).row();
  }
  if (numbers.length > 0 && allowRelease) kb.text('♻️ Release a number', 'n:release:pick').row();
  kb.text('☎️ Get Number', CB.GET_NUMBER).text('🏠 Main Menu', CB.MAIN_MENU).row();
  return tk(kb);
}

export function numberActionKeyboard(numberId: string, opts: { canRelease: boolean; canSuspend?: boolean }): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (opts.canRelease) kb.text('♻️ Release', `n:relok:${numberId}`).row();
  if (opts.canSuspend) kb.text('⚠️ Suspend', `n:susp:${numberId}`).row();
  kb.text('📋 My Numbers', CB.MY_NUMBERS).text('🏠 Main Menu', CB.MAIN_MENU).row();
  return tk(kb);
}

export function sipInfoKeyboard(hasNumbers: boolean): InlineKeyboard {
  const kb = new InlineKeyboard().text('🔄 Rotate password', 's:rotate').row();
  kb.text('📋 Copy-friendly text', 's:plain').text(hasNumbers ? '📋 My Numbers' : '☎️ Get Number', hasNumbers ? CB.MY_NUMBERS : CB.GET_NUMBER).row();
  kb.text('🏠 Main Menu', CB.MAIN_MENU).row();
  return tk(kb);
}

export function referralKeyboard(link: string | null): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (link) {
    kb.url('📤 Share invite link', `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent('Join me on this SIP service')}`).row();
  }
  kb.text('👥 My referrals', 'r:list').text('🏠 Main Menu', CB.MAIN_MENU).row();
  return tk(kb);
}

export function callsKeyboard(page: number, total: number, pageSize: number): InlineKeyboard {
  const kb = new InlineKeyboard();
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (page > 0) kb.text('⬅️ Newer', `c:page:${page - 1}`);
  kb.text(`${page + 1}/${pages}`, 'noop');
  if (page < pages - 1) kb.text('Older ➡️', `c:page:${page + 1}`);
  kb.row().text('☎️ Get Number', CB.GET_NUMBER).text('🏠 Main Menu', CB.MAIN_MENU).row();
  return tk(kb);
}

// -----------------------------------------------------------------------------
// Admin keyboards (spec §33 admin menu tree)
// -----------------------------------------------------------------------------

export function adminMenuKeyboard(pendingCount: number, criticalFindings = 0): InlineKeyboard {
  const kb = new InlineKeyboard()
    .text('📊 Dashboard', 'a:dash')
    .text(`👥 Users${pendingCount > 0 ? ` (${pendingCount}⏳)` : ''}`, 'a:users')
    .row()
    .text('☎️ Numbers', 'a:numbers')
    .text('📱 Services', 'a:services')
    .row()
    .text('💳 Deposits', 'a:deps')
    .text('🏦 Pay Methods', 'a:pms')
    .row()
    .text('🌍 Countries', 'a:countries')
    .text('💎 Plans', 'a:plans')
    .row()
    .text('📞 Live Calls', 'a:live')
    .text('🗂 Call History', 'a:calls')
    .row()
    .text('💰 Referrals', 'a:ref')
    .text('🔧 Settings', 'a:settings')
    .row()
    .text(`🚨 Findings${criticalFindings > 0 ? ` (${criticalFindings})` : ''}`, 'a:findings')
    .text('🩺 Health', 'a:health')
    .row()
    .text('📜 Audit Log', 'a:audit')
    .text('🏠 Main Menu', CB.MAIN_MENU).row();
  return tk(kb);
}

export function userListKeyboard(
  users: Array<{ id: string; username: string | null; telegram_id: number | null; status: string }>,
  page: number,
  total: number,
  pageSize: number,
  filter: string,
): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const user of users) {
    const icon = user.status === 'PENDING' ? '⏳' : user.status === 'ACTIVE' ? '✅' : user.status === 'BLOCKED' ? '⛔️' : '⌛️';
    const label = `${icon} ${user.username ?? user.telegram_id ?? 'user'}`;
    kb.text(label, `a:u:${user.id}`).row();
  }

  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (page > 0) kb.text('⬅️', `a:ul:${filter}:${page - 1}`);
  kb.text(`${page + 1}/${pages}`, 'noop');
  if (page < pages - 1) kb.text('➡️', `a:ul:${filter}:${page + 1}`);
  kb.row();

  kb.text('⏳ Pending', 'a:ul:PENDING:0').text('✅ Active', 'a:ul:ACTIVE:0').row();
  kb.text('⛔️ Blocked', 'a:ul:BLOCKED:0').text('👥 All', 'a:ul:ALL:0').row();
  kb.text('🔍 Search', 'a:usearch').text('🛠 Admin Panel', 'a:home').row();
  return tk(kb);
}

export function userDetailKeyboard(userId: string, status: string, isAdminUser: boolean): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (status === 'PENDING') {
    kb.text('✅ Approve', `a:uap:${userId}`).text('❌ Reject', `a:urej:${userId}`).row();
  }
  if (status === 'ACTIVE') kb.text('⛔️ Block', `a:ublk:${userId}`).text('💎 Change plan', `a:uplan:${userId}`).row();
  if (status === 'BLOCKED') kb.text('♻️ Unblock', `a:uunb:${userId}`).row();
  if (status === 'ACTIVE' || status === 'BLOCKED' || status === 'EXPIRED') {
    kb.text('🔑 SIP credentials', `a:usip:${userId}`).row();
  }
  kb.text('📞 Numbers', `a:unums:${userId}`).text('🗂 Calls', `a:ucalls:${userId}`).row();
  kb.text('💳 Add Balance', `a:fund:${userId}`).text('💰 Referral', `a:uref:${userId}`).row();
  kb.text('🔐 Roles', `a:uroles:${userId}`).row();
  kb.text('🗑 Delete', `a:udel:${userId}`).row();
  kb.text('⬅️ Users', 'a:users').text('🛠 Admin Panel', 'a:home');
  if (!isAdminUser) kb.row().text('⚠️ Suspend all numbers', `a:ususpall:${userId}`);
  return tk(kb);
}

/** Pending deposit requests, each with its own ✅/❌ pair (like user approvals). */
export function depositsQueueKeyboard(requests: { id: string; display_name: string | null; username: string | null; telegram_id: number | null; amount_cents: number }[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const r of requests) {
    const who = r.username ?? r.display_name ?? (r.telegram_id != null ? String(r.telegram_id) : 'user');
    kb.text(`💵 $${(r.amount_cents / 100).toFixed(2)} · ${who}`, 'noop').row();
    kb.text('✅ Approve', `a:dpok:${r.id}`).text('❌ Reject', `a:dpno:${r.id}`).row();
  }
  kb.text('🛠 Admin Panel', 'a:home');
  return tk(kb);
}

export function numbersMenuKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('➕ Add numbers', 'a:nadd')
    .text('📄 CSV import', 'a:ncsv')
    .row()
    .text('📦 Inventory', 'a:nlist:ALL:0')
    .text('🆓 Available', 'a:nlist:AVAILABLE:0')
    .row()
    .text('📞 Assigned', 'a:nlist:ASSIGNED:0')
    .text('⚠️ Suspended', 'a:nlist:SUSPENDED:0')
    .row()
    .text('📥 Import history', 'a:nbatches')
    .text('🔗 Routes', 'a:routes')
    .row()
    .text('🗑 Remove all available', 'a:nwipe')
    .row()
    .text('🛠 Admin Panel', 'a:home').row()
    .text('⬅️ Back', NAV_BACK);
}

export function numberRowKeyboard(numberId: string, status: string): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (status === 'ASSIGNED') {
    kb.text('🚫 Suspend', `a:nsusp:${numberId}`).text('♻️ Release', `a:nrel:${numberId}`).row();
    kb.text('🔀 Reassign', `a:nreas:${numberId}`).text('🔗 Re-sync route', `a:nsync:${numberId}`).row();
  } else if (status === 'SUSPENDED') {
    kb.text('✅ Unsuspend', `a:nunsusp:${numberId}`).text('♻️ Release', `a:nrel:${numberId}`).row();
  } else if (status === 'AVAILABLE') {
    kb.text('👤 Assign to user', `a:nassign:${numberId}`).row();
  }
  kb.text('🗑 Delete', `a:ndel:${numberId}`).row();
  kb.text('⬅️ Inventory', 'a:numbers').text('🛠 Admin Panel', 'a:home').row();
  return tk(kb);
}

export function servicesKeyboard(services: Service[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const s of services) {
    kb.text(`${s.icon ?? '📱'} ${s.name} ${s.status === 'ACTIVE' ? '🟢' : '🔴'}`, `a:svc:${s.id}`).row();
  }
  kb.text('➕ Add service', 'a:svcadd').row();
  kb.text('🛠 Admin Panel', 'a:home').row();
  return tk(kb);
}

export function serviceDetailKeyboard(serviceId: string, status: string): InlineKeyboard {
  return new InlineKeyboard()
    .text('✏️ Rename', `a:svce:${serviceId}:name`)
    .text('🎨 Icon', `a:svce:${serviceId}:icon`)
    .row()
    .text(status === 'ACTIVE' ? '🔴 Disable' : '🟢 Enable', `a:svct:${serviceId}`)
    .row()
    .text('🗑 Remove service', `a:svcdel:${serviceId}`)
    .row()
    .text('⬅️ Services', 'a:services').row()
    .text('⬅️ Back', NAV_BACK);
}

export function countriesKeyboard(countries: Country[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const c of countries.slice(0, 20)) {
    kb.text(`${c.flag ?? '🌍'} ${c.name} +${c.dial_code} ${c.status === 'ACTIVE' ? '🟢' : '🔴'}`, `a:ctry:${c.id}`).row();
  }
  kb.text('➕ Add country', 'a:ctryadd').row();
  kb.text('🛠 Admin Panel', 'a:home').row();
  return tk(kb);
}

export function countryDetailKeyboard(countryId: string, status: string): InlineKeyboard {
  return new InlineKeyboard()
    .text('✏️ Rename', `a:ctrye:${countryId}:name`)
    .text('🎨 Flag', `a:ctrye:${countryId}:flag`)
    .row()
    .text(status === 'ACTIVE' ? '🔴 Disable' : '🟢 Enable', `a:ctryt:${countryId}`)
    .row()
    .text('🗑 Remove country', `a:ctrydel:${countryId}`)
    .row()
    .text('⬅️ Countries', 'a:countries').row()
    .text('⬅️ Back', NAV_BACK);
}

export function plansKeyboard(plans: Plan[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const p of plans) {
    const price = p.price_cents_per_month > 0 ? `${(p.price_cents_per_month / 100).toFixed(2)} ${p.currency}/mo` : 'Free';
    kb.text(`${p.is_default ? '⭐️ ' : ''}${p.name} · ${p.max_numbers} nums · ${price}`, `a:plan:${p.id}`).row();
  }
  kb.text('➕ Add plan', 'a:planadd').row();
  kb.text('🛠 Admin Panel', 'a:home').row();
  return tk(kb);
}

export function planDetailKeyboard(planId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text('➕1 number', `a:planmax:${planId}:1`)
    .text('➕5 numbers', `a:planmax:${planId}:5`)
    .row()
    .text('💎 Premium: toggle', `a:planprem:${planId}`)
    .text('💶 Set price', `a:planprice:${planId}`)
    .row()
    .text('📅 Set duration', `a:plandur:${planId}`)
    .text('🟢/🔴 Toggle active', `a:plant:${planId}`)
    .row()
    .text('🌍 Country access', `a:plancountries:${planId}`)
    .text('📱 Service access', `a:planservices:${planId}`)
    .row()
    .text('⬅️ Plans', 'a:plans').row()
    .text('⬅️ Back', NAV_BACK);
}

export function settingsKeyboard(keys: Array<{ key: string; label: string; value: unknown }>): InlineKeyboard {
  const kb = new InlineKeyboard();
  keys.forEach((s, index) => {
    const short = String(s.value).slice(0, 14);
    kb.text(`${s.label.slice(0, 22)}: ${short}`, `a:set:${s.key}`);
    if (index % 2 === 1) kb.row();
  });
  if (keys.length % 2 === 1) kb.row();
  kb.text('🛠 Admin Panel', 'a:home').row();
  return tk(kb);
}

export function referralsAdminKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('⚙️ Programme settings', 'a:refset')
    .text('💸 Payout queue', 'a:refpay')
    .row()
    .text('🏆 Top referrers', 'a:reftop')
    .row()
    .text('🛠 Admin Panel', 'a:home').row()
    .text('⬅️ Back', NAV_BACK);
}

export function referrerListKeyboard(rows: Array<{ user_id: string; username: string | null; qualified: number; earned_cents: number }>): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const r of rows) {
    kb.text(`${r.username ?? 'user'} · ${r.qualified} ✓ · ${(r.earned_cents / 100).toFixed(2)}`, `a:uref:${r.user_id}`).row();
  }
  kb.text('💰 Referrals', 'a:ref').row();
  return tk(kb);
}

export function commissionKeyboard(commissionId: string): InlineKeyboard {
  return tk(new InlineKeyboard()
    .text('✅ Mark paid', `a:cmpay:${commissionId}`)
    .text('🚫 Reject', `a:cmrej:${commissionId}`)
    .row()
    .text('💸 Payout queue', 'a:refpay'));
}

export function findingsKeyboard(findings: Array<{ id: string }>): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const f of findings.slice(0, 8)) {
    kb.text('✅ Resolve', `a:fresolve:${f.id}`).row();
  }
  kb.text('🔄 Run reconciliation now', 'a:runsync').row();
  kb.text('🛠 Admin Panel', 'a:home').row();
  return tk(kb);
}

export function healthKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('🔄 Probe PBX now', 'a:probe')
    .text('🔄 Run reconciliation', 'a:runsync')
    .row()
    .text('📊 Dashboard', 'a:dash')
    .text('🛠 Admin Panel', 'a:home').row()
    .text('⬅️ Back', NAV_BACK);
}

export function auditKeyboard(page: number, hasMore: boolean): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (page > 0) kb.text('⬅️ Newer', `a:audit:${page - 1}`);
  if (hasMore) kb.text('Older ➡️', `a:audit:${page + 1}`);
  kb.row().text('🛠 Admin Panel', 'a:home').row();
  return tk(kb);
}

export function planPickerKeyboard(plans: Plan[], prefix: string): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const plan of plans) kb.text(`${plan.name}`, `${prefix}:${plan.id}`).row();
  kb.text('⬅️ Back', NAV_BACK);
  return kb;
}

/** Renders one line of inventory for list screens. */
export function numberLine(n: NumberWithCatalog): string {
  const icon = n.status === 'AVAILABLE' ? '🟢' : n.status === 'ASSIGNED' ? '📞' : n.status === 'SUSPENDED' ? '⚠️' : '⚪️';
  const expiry = n.expiration_date ? `⏳${formatDate(n.expiration_date)}` : '';
  return `${icon} <code>${n.phone_number}</code> ${n.country_flag ?? ''} ${n.service_icon ?? ''} ${n.plan_type === 'PREMIUM' ? '💎' : ''} ${expiry}`;
}
