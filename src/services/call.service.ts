import { many, one, query, withTransaction } from '../db/pool.js';
import { maskNumber, logger } from '../lib/logger.js';
import { getFreePBX, getLiveCallSource } from '../freepbx/index.js';
import type { CdrRecord, LiveCall, LiveCallEvent } from '../freepbx/types.js';
import { didCandidates } from '../lib/phone.js';
import { getString, getBool } from './settings.service.js';

/**
 * Call data (spec §20, §21).
 *
 * LIVE vs HISTORICAL - the distinction is enforced structurally:
 *   * `getLiveCalls()` reads call_sessions, which is fed exclusively by AMI
 *     events (never by CDR).
 *   * `getCallHistory()` reads call_history, which is fed exclusively by the
 *     documented CDR GraphQL queries.
 *
 * Per-user visibility is enforced in SQL (WHERE user_id = $1): a normal user can
 * only ever see rows belonging to them, and admins read the same table with a
 * different predicate. There is no code path where a user id from a callback
 * decides what another user may see (spec §21).
 */

export interface LiveCallView {
  channel: string;
  caller: string;
  did: string | null;
  extension: string | null;
  state: string;
  direction: string;
  startedAt: Date;
  durationSeconds: number;
  username: string | null;
  telegramId: number | null;
  ownerName: string | null;
}

export interface CallHistoryRow {
  id: string;
  calldate: Date;
  src: string | null;
  dst: string | null;
  did: string | null;
  duration: number;
  billsec: number;
  disposition: string | null;
  direction: string | null;
  sip_extension: string | null;
  username: string | null;
}

// -----------------------------------------------------------------------------
// Live calls (AMI)
// -----------------------------------------------------------------------------

export async function liveCallSourceStatus(): Promise<{ available: boolean; detail?: string }> {
  const src = getLiveCallSource();
  const status = src.status();
  if (src.kind === 'disabled') {
    return {
      available: false,
      detail:
        'Live call monitoring is not enabled. It requires the Asterisk Manager Interface (AMI_ENABLED=true, AMI_USER, AMI_SECRET). The PBX GraphQL API has no documented query for calls in progress, and CDR records are written only after a call ends.',
    };
  }
  return { available: status.connected, ...(status.detail ? { detail: status.detail } : {}) };
}

/**
 * Refreshes call_sessions from the live source and returns the current snapshot.
 * A stale row (no event for 2 hours) is swept: a channel cannot realistically
 * stay up that long without emitting events.
 */
export async function refreshLiveSessions(): Promise<LiveCall[]> {
  const src = getLiveCallSource();
  if (src.kind === 'disabled') return [];
  const calls = await src.listActiveCalls();

  await withTransaction(async (client) => {
    const seen = new Set<string>();
    for (const call of calls) {
      seen.add(call.channel);
      const owner = await resolveOwner(call.did, call.extension);
      await client.query(
        `INSERT INTO call_sessions (channel, uniqueid, linkedid, caller, connected_to, did, direction, state,
                                    started_at, answered_at, last_event_at, number_id, user_id, sip_extension, raw)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now(),$11,$12,$13,$14::jsonb)
         ON CONFLICT (channel) DO UPDATE SET
            state = EXCLUDED.state,
            connected_to = EXCLUDED.connected_to,
            did = COALESCE(EXCLUDED.did, call_sessions.did),
            answered_at = COALESCE(call_sessions.answered_at, EXCLUDED.answered_at),
            last_event_at = now(),
            number_id = COALESCE(EXCLUDED.number_id, call_sessions.number_id),
            user_id = COALESCE(EXCLUDED.user_id, call_sessions.user_id),
            sip_extension = COALESCE(EXCLUDED.sip_extension, call_sessions.sip_extension)`,
        [
          call.channel,
          call.uniqueid ?? null,
          call.linkedid ?? null,
          call.caller,
          call.connectedTo ?? null,
          call.did ?? null,
          call.direction,
          call.state,
          call.startedAt,
          call.answeredAt ?? null,
          owner.numberId,
          owner.userId,
          owner.extension,
          JSON.stringify({}),
        ],
      );
    }

    // Remove sessions that are no longer active and stale ones.
    if (seen.size > 0) {
      await client.query('DELETE FROM call_sessions WHERE NOT (channel = ANY($1::text[]))', [[...seen]]);
    }
    await client.query("DELETE FROM call_sessions WHERE last_event_at < now() - interval '2 hours'");
  });

  return calls;
}

/** Applies a single AMI event to call_sessions (keeps the table event-driven). */
export async function applyLiveEvent(event: LiveCallEvent): Promise<void> {
  try {
    if (event.type === 'channel_hangup') {
      await query('DELETE FROM call_sessions WHERE channel = $1', [event.channel]);
      return;
    }
    const call = event.call;
    const owner = await resolveOwner(call.did, call.extension);
    await query(
      `INSERT INTO call_sessions (channel, uniqueid, linkedid, caller, connected_to, did, direction, state,
                                  started_at, answered_at, last_event_at, number_id, user_id, sip_extension)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now(),$11,$12,$13)
       ON CONFLICT (channel) DO UPDATE SET
          state = EXCLUDED.state, connected_to = EXCLUDED.connected_to, last_event_at = now(),
          answered_at = COALESCE(call_sessions.answered_at, EXCLUDED.answered_at)`,
      [
        call.channel,
        call.uniqueid ?? null,
        call.linkedid ?? null,
        call.caller,
        call.connectedTo ?? null,
        call.did ?? null,
        call.direction,
        call.state,
        call.startedAt,
        call.answeredAt ?? null,
        owner.numberId,
        owner.userId,
        owner.extension,
      ],
    );
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'failed to persist live call event');
  }
}

/** Maps a DID/extension to the owning number and user. */
async function resolveOwner(
  did: string | null | undefined,
  extension: string | null | undefined,
): Promise<{ numberId: string | null; userId: string | null; extension: string | null }> {
  if (did) {
    const candidates = didCandidates(did.startsWith('+') ? did : `+${did.replace(/\D/g, '')}`);
    const row = await one<{ id: string; assigned_user_id: string | null; sip_extension: string | null }>(
      `SELECT id, assigned_user_id, sip_extension FROM numbers
        WHERE phone_number = ANY($1::text[]) OR did_match_pattern = ANY($1::text[]) LIMIT 1`,
      [candidates],
    );
    if (row) return { numberId: row.id, userId: row.assigned_user_id, extension: row.sip_extension };
  }
  if (extension) {
    const row = await one<{ id: string; user_id: string }>(
      `SELECT n.id, s.user_id FROM sip_accounts s
         LEFT JOIN numbers n ON n.sip_extension = s.extension AND n.status IN ('ASSIGNED','SUSPENDED')
        WHERE s.extension = $1 LIMIT 1`,
      [extension],
    );
    if (row?.user_id) return { numberId: row.id ?? null, userId: row.user_id, extension };
  }
  return { numberId: null, userId: null, extension: extension ?? null };
}

/** Live call list for the admin panel (all users). */
export async function getLiveCalls(): Promise<LiveCallView[]> {
  const rows = await many<{
    channel: string;
    caller: string | null;
    did: string | null;
    sip_extension: string | null;
    state: string | null;
    direction: string | null;
    started_at: Date;
    username: string | null;
    telegram_id: number | null;
    display_name: string | null;
  }>(
    `SELECT cs.channel, cs.caller, cs.did, cs.sip_extension, cs.state, cs.direction, cs.started_at,
            u.username, u.telegram_id, u.display_name
       FROM call_sessions cs
       LEFT JOIN users u ON u.id = cs.user_id
      ORDER BY cs.started_at DESC
      LIMIT 50`,
  );

  return rows.map((r) => ({
    channel: r.channel,
    caller: r.caller ?? '',
    did: r.did,
    extension: r.sip_extension,
    state: r.state ?? 'Unknown',
    direction: r.direction ?? 'UNKNOWN',
    startedAt: r.started_at,
    durationSeconds: Math.max(0, Math.round((Date.now() - r.started_at.getTime()) / 1000)),
    username: r.username,
    telegramId: r.telegram_id,
    ownerName: r.display_name,
  }));
}

/** Live calls belonging to ONE user (used by the user-facing call screen). */
export async function getLiveCallsForUser(userId: string): Promise<LiveCallView[]> {
  const rows = await many<{
    channel: string;
    caller: string | null;
    did: string | null;
    sip_extension: string | null;
    state: string | null;
    direction: string | null;
    started_at: Date;
  }>(
    `SELECT channel, caller, did, sip_extension, state, direction, started_at
       FROM call_sessions
      WHERE user_id = $1
      ORDER BY started_at DESC
      LIMIT 20`,
    [userId],
  );

  return rows.map((r) => ({
    channel: r.channel,
    caller: r.caller ?? '',
    did: r.did,
    extension: r.sip_extension,
    state: r.state ?? 'Unknown',
    direction: r.direction ?? 'UNKNOWN',
    startedAt: r.started_at,
    durationSeconds: Math.max(0, Math.round((Date.now() - r.started_at.getTime()) / 1000)),
    username: null,
    telegramId: null,
    ownerName: null,
  }));
}

// -----------------------------------------------------------------------------
// CDR ingestion (historical)
// -----------------------------------------------------------------------------

export interface IngestResult {
  fetched: number;
  inserted: number;
  skipped: number;
  matchedToUsers: number;
}

/**
 * Pulls CDR pages from the documented `fetchAllCdrs` query and mirrors them
 * locally. Paging is `first`/`after` (limit/offset) per the documentation, with
 * an optional date window.
 */
export async function ingestCdrs(opts: { lookbackHours?: number; maxPages?: number; pageSize?: number } = {}): Promise<IngestResult> {
  const pbx = getFreePBX();
  const lookbackHours = opts.lookbackHours ?? (await getNumberSetting('reconcile.lookback_hours', 24));
  const pageSize = opts.pageSize ?? 200;
  const maxPages = opts.maxPages ?? 10;

  const start = new Date(Date.now() - lookbackHours * 3_600_000);
  const startDate = start.toISOString().slice(0, 10);
  const endDate = new Date().toISOString().slice(0, 10);

  let fetched = 0;
  let inserted = 0;
  let skipped = 0;
  let matchedToUsers = 0;

  for (let page = 0; page < maxPages; page += 1) {
    const res = await pbx.getCdrs({ first: pageSize, after: page * pageSize, orderby: 'date', startDate, endDate });
    fetched += res.cdrs.length;
    if (res.cdrs.length === 0) break;

    for (const cdr of res.cdrs) {
      const result = await ingestSingleCdr(cdr);
      if (result.inserted) inserted += 1;
      else skipped += 1;
      if (result.matched) matchedToUsers += 1;
    }
    if (res.cdrs.length < pageSize) break;
  }

  await query(
    `INSERT INTO cdr_sync_state (id, last_synced_at, total_imported)
     VALUES ('default', now(), $1)
     ON CONFLICT (id) DO UPDATE SET last_synced_at = now(), total_imported = cdr_sync_state.total_imported + $1`,
    [inserted],
  );

  logger.info({ fetched, inserted, skipped, matchedToUsers }, 'CDR ingestion finished');
  return { fetched, inserted, skipped, matchedToUsers };
}

async function ingestSingleCdr(cdr: CdrRecord): Promise<{ inserted: boolean; matched: boolean }> {
  const calldate = new Date(`${cdr.calldate}Z`.replace(' ', 'T').replace('ZZ', 'Z'));
  const when = Number.isNaN(calldate.getTime()) ? new Date() : calldate;

  // Resolve the DID: CDR carries the DID in `did` on some FreePBX builds and in
  // `dst` on others, so try both instead of assuming one.
  const rawDid = (cdr.did && cdr.did.trim()) || (cdr.dst && /^\+?\d{7,15}$/.test(cdr.dst) ? cdr.dst : '');
  let numberId: string | null = null;
  let userId: string | null = null;
  let extension: string | null = null;

  if (rawDid) {
    const digits = rawDid.replace(/\D/g, '');
    const candidates = didCandidates(`+${digits}`);
    const number = await one<{ id: string; assigned_user_id: string | null; sip_extension: string | null }>(
      `SELECT id, assigned_user_id, sip_extension FROM numbers
        WHERE phone_number = ANY($1::text[]) OR did_match_pattern = ANY($1::text[]) LIMIT 1`,
      [candidates],
    );
    if (number) {
      numberId = number.id;
      userId = number.assigned_user_id;
      extension = number.sip_extension;
    }
  }

  const direction = determineDirection(cdr);

  const res = await query(
    `INSERT INTO call_history (uniqueid, linkedid, freepbx_cdr_id, calldate, clid, src, dst, did, dcontext, channel,
                               dstchannel, lastapp, lastdata, duration, billsec, disposition, direction, recordingfile,
                               amaflags, number_id, user_id, sip_extension, raw)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23::jsonb)
     ON CONFLICT (uniqueid) DO NOTHING`,
    [
      cdr.uniqueid,
      cdr.linkedid ?? null,
      cdr.id ?? null,
      when,
      cdr.clid ?? null,
      cdr.src ?? null,
      cdr.dst ?? null,
      numberId ? rawDid : null,
      cdr.dcontext ?? null,
      cdr.channel ?? null,
      cdr.dstchannel ?? null,
      cdr.lastapp ?? null,
      cdr.lastdata ?? null,
      cdr.duration ?? 0,
      cdr.billsec ?? 0,
      cdr.disposition ?? null,
      direction,
      cdr.recordingfile ?? null,
      cdr.amaflags ?? null,
      numberId,
      userId,
      extension,
      JSON.stringify(cdr),
    ],
  );

  return { inserted: (res.rowCount ?? 0) > 0, matched: Boolean(numberId) };
}

function determineDirection(cdr: CdrRecord): 'INBOUND' | 'OUTBOUND' | 'INTERNAL' | 'UNKNOWN' {
  const ctx = `${cdr.dcontext ?? ''}`;
  if (/from-trunk|from-pstn|from-did|from-external/i.test(ctx)) return 'INBOUND';
  if (/from-internal|from-did-direct/i.test(ctx)) return 'INTERNAL';
  if (cdr.channel?.startsWith('SIP/') || cdr.channel?.startsWith('PJSIP/')) {
    if (cdr.dstchannel?.includes('/')) return 'OUTBOUND';
  }
  return 'UNKNOWN';
}

async function getNumberSetting(key: string, fallback: number): Promise<number> {
  const raw = await getString(key, String(fallback));
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

// -----------------------------------------------------------------------------
// History queries
// -----------------------------------------------------------------------------

export async function getUserCallHistory(
  userId: string,
  opts: { limit?: number; offset?: number; numberId?: string; from?: Date; to?: Date } = {},
): Promise<{ rows: CallHistoryRow[]; total: number }> {
  const params: unknown[] = [userId];
  const conditions = ['c.user_id = $1'];
  if (opts.numberId) {
    params.push(opts.numberId);
    conditions.push(`c.number_id = $${params.length}`);
  }
  if (opts.from) {
    params.push(opts.from);
    conditions.push(`c.calldate >= $${params.length}`);
  }
  if (opts.to) {
    params.push(opts.to);
    conditions.push(`c.calldate <= $${params.length}`);
  }
  const where = `WHERE ${conditions.join(' AND ')}`;

  const totalRes = await query<{ count: string }>(`SELECT count(*)::text AS count FROM call_history c ${where}`, params);
  const limit = Math.min(opts.limit ?? 10, 50);
  const offset = opts.offset ?? 0;
  params.push(limit, offset);

  const rows = await many<CallHistoryRow>(
    `SELECT c.id, c.calldate, c.src, c.dst, c.did, c.duration, c.billsec, c.disposition, c.direction, c.sip_extension, u.username
       FROM call_history c LEFT JOIN users u ON u.id = c.user_id
       ${where}
      ORDER BY c.calldate DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return { rows, total: Number(totalRes.rows[0]?.count ?? 0) };
}

/** Admin-wide history. Same table, no user predicate - available to admins only. */
export async function getSystemCallHistory(opts: { limit?: number; offset?: number; did?: string } = {}): Promise<{ rows: CallHistoryRow[]; total: number }> {
  const params: unknown[] = [];
  const conditions: string[] = ['1=1'];
  if (opts.did) {
    params.push(`%${opts.did.replace(/\D/g, '')}%`);
    conditions.push(`c.did LIKE $${params.length}`);
  }
  const where = `WHERE ${conditions.join(' AND ')}`;

  const totalRes = await query<{ count: string }>(`SELECT count(*)::text AS count FROM call_history c ${where}`, params);
  const limit = Math.min(opts.limit ?? 10, 50);
  const offset = opts.offset ?? 0;
  params.push(limit, offset);

  const rows = await many<CallHistoryRow>(
    `SELECT c.id, c.calldate, c.src, c.dst, c.did, c.duration, c.billsec, c.disposition, c.direction, c.sip_extension, u.username
       FROM call_history c LEFT JOIN users u ON u.id = c.user_id
       ${where}
      ORDER BY c.calldate DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return { rows, total: Number(totalRes.rows[0]?.count ?? 0) };
}

export async function getCallsTodayCount(): Promise<number> {
  const res = await query<{ count: string }>(
    `SELECT count(*)::text AS count FROM call_history WHERE calldate >= date_trunc('day', now() at time zone 'utc')`,
  );
  return Number(res.rows[0]?.count ?? 0);
}

/** Masks a caller ID for display: +971501234567 -> +9715****567 */
export function displayCaller(value: string | null | undefined): string {
  return value ? maskNumber(value) : 'Unknown';
}
