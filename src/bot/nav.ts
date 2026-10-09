import type { BotContext } from './context.js';

/**
 * Navigation with a real back button.
 *
 * The problem this solves: every screen used to hard-code its own "way up"
 * button, with a different label each time ("🛠 Admin", "🏠 Menu", "⬅️ Numbers"),
 * and a few screens had none at all. The result was that a user who entered a
 * menu had no obvious way back, because "back" is not a property any single
 * keyboard can know.
 *
 * How it works
 * ------------
 *  * Every **pure-render** callback (a callback that only shows a screen) is
 *    pushed onto a stack stored in the session (`bot_sessions`, so it survives
 *    restarts and is shared between instances).
 *  * The universal "⬅️ Back" button (`nav:back`) pops the stack and re-dispatches
 *    the previous screen through the normal callback dispatcher, so Back always
 *    returns exactly where the user came from - including across admin screens
 *    reached from different places.
 *  * Mutating callbacks are deliberately NOT pushed: replaying an approval or a
 *    release must be impossible. After an action, Back therefore returns to the
 *    screen the user was on when they acted, which is what people expect.
 */

/** Callback data of the universal back button. */
export const NAV_BACK = 'nav:back';

/** Deepest stack we keep, to bound the session row size. */
const MAX_DEPTH = 25;

/**
 * Callbacks that only render a screen, keyed by exactly the data the bot
 * registers. Anything not matched here is treated as an action and never
 * replayed - the list is an allowlist on purpose (fail closed).
 */
const REPLAYABLE: RegExp[] = [
  // user: main navigation
  /^m:(get|nums|sip|calls|ref|sup|help|wallet|dep)$/,
  // user: get-number flow (pickers and prompts only; n:get: assigns, n:relyes: releases)
  /^n:c:[0-9a-f-]{36}$/,
  /^n:cp:\d+$/,
  /^n:s:[0-9a-f-]{36}$/,
  /^n:back:countries$/,
  /^n:back:services:[0-9a-f-]{36}$/,
  /^n:info:[0-9a-f-]{36}$/,
  /^n:release:pick$/,
  /^n:relok:[0-9a-f-]{36}$/,
  /^n:susp:[0-9a-f-]{36}$/,
  /^n:back:numbers$/,
  // user: calls, referrals, SIP details
  /^c:page:\d+$/,
  /^r:list$/,
  /^s:rotate$/, // confirmation prompt, not the rotation itself
  /^s:plain$/,
  // admin: top level and menus
  /^a:home$/,
  /^a:(dash|users|numbers|services|countries|plans|live|calls|ref|settings|findings|health|routes|nbatches|refpay|refset|reftop|deps|pms|pmadd)$/,
  // admin: list pages and detail screens
  /^a:ul:(ALL|PENDING|ACTIVE|BLOCKED|EXPIRED|DELETED):\d+$/,
  /^a:nlist:(ALL|AVAILABLE|ASSIGNED|SUSPENDED|RESERVED|EXPIRED|DISABLED):\d+$/,
  /^a:audit:\d+$/,
  /^a:u:[0-9a-f-]{36}$/,
  /^a:n:[0-9a-f-]{36}$/,
  /^a:svc:[0-9a-f-]{36}$/,
  /^a:ctry:[0-9a-f-]{36}$/,
  /^a:plan:[0-9a-f-]{36}$/,
  /^a:jobinfo:[0-9a-f-]{36}$/,
  // admin: prompts that ask for input (they render a screen and set a step)
  /^a:(nadd|ncsv|ctryadd|svcadd|usearch|broadcast|planadd)$/,
  /^a:fund:[0-9a-f-]{36}$/,
  /^a:pm:[0-9a-f-]{36}$/,
  /^a:pmedit:[0-9a-f-]{36}$/,
  /^dep:m:[0-9a-f-]{36}$/,
  /^a:svce:[0-9a-f-]{36}:(name|icon|description)$/,
  /^a:ctrye:[0-9a-f-]{36}:(name|flag|dial_code)$/,
  /^a:set:[a-z_.]+$/,
  /^a:plancountries:[0-9a-f-]{36}$/,
  /^a:planservices:[0-9a-f-]{36}$/,
  // admin: per-user views (reads; the SIP credential view is excluded so Back
  // does not write a second SIP_PASSWORD_VIEWED audit row)
  /^a:(unums|ucalls|uref|uroles):[0-9a-f-]{36}$/,
];

/** True when re-dispatching this callback can only re-render, never mutate. */
export function isReplayable(data: string): boolean {
  return REPLAYABLE.some((re) => re.test(data));
}

function stack(ctx: BotContext): string[] {
  const current = ctx.session.navStack;
  return Array.isArray(current) ? current : [];
}

/** Records that the user is now looking at the screen rendered by `data`. */
export function pushNav(ctx: BotContext, data: string): void {
  const next = [...stack(ctx), data].slice(-MAX_DEPTH);
  ctx.session.navStack = next;
}

/** Resets navigation to the root (the main menu). */
export function resetNav(ctx: BotContext): void {
  ctx.session.navStack = [];
}

/**
 * Pops the current screen and returns the one to render next, or null when the
 * user is already at the root.
 */
export function popNav(ctx: BotContext): string | null {
  const current = stack(ctx);
  if (current.length === 0) return null;
  current.pop();
  const previous = current[current.length - 1] ?? null;
  ctx.session.navStack = current;
  return previous;
}

/**
 * Removes stack entries that point at something which no longer exists.
 *
 * Called by the destructive admin actions (remove country / service / number,
 * delete user): without it the entry for the deleted entity stays in the stack
 * and the next Back re-dispatches it, landing the admin on a screen that cannot
 * render - the button looks dead.
 */
export function dropNavMatching(ctx: BotContext, matches: (data: string) => boolean): number {
  const before = stack(ctx);
  const after = before.filter((data) => !matches(data));
  ctx.session.navStack = after;
  return before.length - after.length;
}

/**
 * Records the screen the user is looking at right now, including transient
 * screens that are deliberately kept off the stack.
 */
export function markRendered(ctx: BotContext, data: string): void {
  ctx.session.lastRendered = data;
}

/** The last screen rendered for this user, if the session still knows it. */
export function lastRendered(ctx: BotContext): string | null {
  const value = ctx.session.lastRendered;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Removes and returns the top of the stack.
 *
 * Used by Back when the user is on a transient screen: its parent is then
 * re-rendered through the normal dispatcher, which pushes it again, so the
 * stack ends up exactly as it was - no phantom level is created.
 */
export function takeTop(ctx: BotContext): string | null {
  const current = stack(ctx);
  const top = current.pop() ?? null;
  ctx.session.navStack = current;
  return top;
}

/** The screen the user is currently on (top of the stack), if any. */
export function currentScreen(ctx: BotContext): string | null {
  const current = stack(ctx);
  return current[current.length - 1] ?? null;
}
