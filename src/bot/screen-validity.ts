import { one } from '../db/pool.js';

/**
 * Can the screen described by this callback data still be rendered?
 *
 * The navigation stack stores what the user was looking at. When the thing
 * they were looking at is *deleted* while its screen sits in the stack (an
 * admin removes a country and then presses Back), re-dispatching that entry
 * used to reach a handler that returned without sending anything - so the
 * button looked dead. Back now skips entries that no longer exist.
 *
 * Only detail screens are checked; menus and lists render from live data
 * whatever happened in between.
 */
interface Check {
  re: RegExp;
  table: 'countries' | 'services' | 'users' | 'numbers' | 'plans';
}

const CHECKS: Check[] = [
  { re: /^a:ctry:([0-9a-f-]{36})$/, table: 'countries' },
  { re: /^a:svc:([0-9a-f-]{36})$/, table: 'services' },
  { re: /^a:svce:([0-9a-f-]{36}):(name|icon|description)$/, table: 'services' },
  { re: /^a:u:([0-9a-f-]{36})$/, table: 'users' },
  { re: /^a:(unums|ucalls|uref|uroles):([0-9a-f-]{36})$/, table: 'users' },
  { re: /^a:n:([0-9a-f-]{36})$/, table: 'numbers' },
  { re: /^a:plan:([0-9a-f-]{36})$/, table: 'plans' },
];

export async function isScreenStillValid(data: string): Promise<boolean> {
  const hit = CHECKS.find((c) => c.re.test(data));
  if (!hit) return true;
  const id = data.match(hit.re)?.[1];
  if (!id) return true;
  // `table` comes from the fixed list above - never from user input.
  const row = await one<{ id: string }>(`SELECT id FROM ${hit.table} WHERE id = $1 AND deleted_at IS NULL`, [id]);
  return Boolean(row);
}
