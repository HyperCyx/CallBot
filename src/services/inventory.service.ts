import { parse as parseCsv } from 'csv-parse/sync';
import { many, one, query, scalar, withTransaction } from '../db/pool.js';
import { AppError, badInput, conflict, notFound } from '../lib/errors.js';
import { didMatch, InvalidPhoneNumberError, normalizeE164 } from '../lib/phone.js';
import { logger, maskNumber } from '../lib/logger.js';
import { writeAudit } from './audit.service.js';
import { enqueueJob } from './pbxJob.service.js';
import { getCountry, getService } from './catalog.service.js';

/**
 * Number inventory management (spec §10, §11, §17).
 *
 * Import rules that matter in production:
 *  * numbers are normalised to E.164 and stored together with the exact string
 *    the trunk delivers (`did_match_pattern`) - see src/lib/phone.ts;
 *  * duplicates are REJECTED, never silently overwritten (a duplicate usually
 *    means two carriers leased the same DID, which is a billing incident, not
 *    something to paper over);
 *  * numbers already assigned to a user are never touched by an import;
 *  * the whole import is recorded in number_import_batches with counts and
 *    per-row errors so an admin can audit what happened.
 */

export type NumberStatus = 'AVAILABLE' | 'RESERVED' | 'ASSIGNED' | 'SUSPENDED' | 'EXPIRED' | 'DISABLED';

export interface NumberRow {
  id: string;
  phone_number: string;
  did_match_pattern: string | null;
  country_id: string;
  service_id: string;
  provider: string | null;
  status: NumberStatus;
  plan_type: 'FREE' | 'PREMIUM';
  price_cents: number | null;
  currency: string;
  assigned_user_id: string | null;
  assigned_at: Date | null;
  sip_extension: string | null;
  expiration_date: Date | null;
  last_route_sync_at: Date | null;
  status_reason?: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

export interface NumberWithCatalog extends NumberRow {
  country_name: string;
  country_flag: string | null;
  service_name: string;
  service_icon: string | null;
}

export interface ImportResult {
  batchId: string;
  totalRows: number;
  imported: number;
  duplicates: number;
  invalid: number;
  skippedAssigned: number;
  errors: Array<{ row: number; value: string; reason: string }>;
}

export interface ImportInput {
  countryId: string;
  serviceId: string;
  planType: 'FREE' | 'PREMIUM';
  provider?: string | null;
  priceCents?: number | null;
  currency?: string;
  expirationDate?: string | null;
  /** Raw CSV text (header optional) or an explicit list of numbers. */
  csvText?: string;
  numbers?: string[];
  actorId: string;
  actorTelegramId?: number | null;
  source?: 'CSV' | 'SINGLE' | 'BULK' | 'API' | 'UPLOAD';
  originalName?: string | null;
}

/** Extracts number candidates from CSV text. Tolerates an optional header. */
export function parseNumberCsv(csvText: string): { values: string[]; malformed: number } {
  let records: string[][];
  try {
    records = parseCsv(csvText, {
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
      bom: true,
    }) as string[][];
  } catch (err) {
    throw badInput(`Could not parse the CSV file: ${(err as Error).message}`);
  }

  const values: string[] = [];
  let malformed = 0;
  for (const row of records) {
    if (!row || row.length === 0) continue;
    const first = (row[0] ?? '').trim();
    if (!first) continue;
    // Skip the header row(s).
    if (/^(phone_?number|number|did|msisdn)$/i.test(first)) continue;
    if (/^[+0-9()\-.\s]+$/.test(first)) values.push(first);
    else malformed += 1;
  }
  return { values, malformed };
}

export async function importNumbers(input: ImportInput): Promise<ImportResult> {
  const country = await getCountry(input.countryId);
  if (!country) throw notFound('Country');
  const service = await getService(input.serviceId);
  if (!service) throw notFound('Service');

  // Importing into a disabled catalog entry would create inventory that no user
  // can ever be assigned from, so it is refused instead of silently accepted.
  if (country.status !== 'ACTIVE') {
    throw badInput(`Country ${country.name} is ${country.status}. Enable it before importing numbers.`);
  }
  if (service.status !== 'ACTIVE') {
    throw badInput(`Service ${service.name} is ${service.status}. Enable it before importing numbers.`);
  }

  let raw: string[] = [];
  if (input.csvText) {
    const { values, malformed } = parseNumberCsv(input.csvText);
    raw = values;
    if (malformed > 0) {
      logger.warn({ malformed }, 'rows skipped during CSV parse (not number-like)');
    }
  }
  if (input.numbers?.length) raw = [...raw, ...input.numbers];

  if (raw.length === 0) throw badInput('No numbers found in the input.');
  if (raw.length > 5_000) throw badInput('A single import is limited to 5000 numbers. Split the file and retry.');

  const errors: ImportResult['errors'] = [];
  const seen = new Set<string>();

  type Candidate = {
    e164: string;
    didPattern: string;
    row: number;
    original: string;
  };
  const candidates: Candidate[] = [];

  raw.forEach((value, index) => {
    const rowNumber = index + 1;
    try {
      const { e164 } = normalizeE164(value, country.dial_code);
      if (seen.has(e164)) {
        errors.push({ row: rowNumber, value, reason: 'duplicate inside this import' });
        return;
      }
      // Cheap plausibility check: the number should belong to the selected country.
      if (!e164.startsWith(`+${country.dial_code}`)) {
        errors.push({
          row: rowNumber,
          value,
          reason: `number does not match the selected country dial code +${country.dial_code}`,
        });
        return;
      }
      seen.add(e164);
      candidates.push({ e164, didPattern: didMatch(e164), row: rowNumber, original: value });
    } catch (err) {
      const reason = err instanceof InvalidPhoneNumberError ? 'not a valid phone number' : (err as Error).message;
      errors.push({ row: rowNumber, value, reason });
    }
  });

  const invalid = errors.length;
  let imported = 0;
  let duplicates = 0;
  let skippedAssigned = 0;

  const batchId = await withTransaction(async (client) => {
    const batch = await client.query<{ id: string }>(
      `INSERT INTO number_import_batches (actor_id, country_id, service_id, plan_type, source, original_name, total_rows, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'RUNNING') RETURNING id`,
      [
        input.actorId,
        input.countryId,
        input.serviceId,
        input.planType,
        input.source ?? (input.csvText ? 'CSV' : 'SINGLE'),
        input.originalName ?? null,
        raw.length,
      ],
    );
    const id = batch.rows[0]!.id;

    for (const candidate of candidates) {
      // Never touch an existing row: duplicates and assignments are protected.
      const existing = await client.query<{ id: string; status: NumberStatus; assigned_user_id: string | null }>(
        'SELECT id, status, assigned_user_id FROM numbers WHERE phone_number = $1 AND deleted_at IS NULL',
        [candidate.e164],
      );
      const row = existing.rows[0];
      if (row) {
        if (row.status === 'ASSIGNED' || row.status === 'SUSPENDED' || row.assigned_user_id) {
          skippedAssigned += 1;
        } else {
          duplicates += 1;
        }
        errors.push({
          row: candidate.row,
          value: candidate.original,
          reason: row.assigned_user_id
            ? `already in inventory and currently assigned (status ${row.status}) - not overwritten`
            : `already in inventory (status ${row.status})`,
        });
        continue;
      }

      await client.query(
        `INSERT INTO numbers (phone_number, did_match_pattern, country_id, service_id, provider, status, plan_type,
                              price_cents, currency, expiration_date, metadata)
         VALUES ($1,$2,$3,$4,$5,'AVAILABLE',$6,$7,$8,$9,$10::jsonb)`,
        [
          candidate.e164,
          candidate.didPattern,
          input.countryId,
          input.serviceId,
          input.provider ?? null,
          input.planType,
          input.priceCents ?? null,
          input.currency ?? 'EUR',
          input.expirationDate ?? null,
          JSON.stringify({ importedBy: input.actorId }),
        ],
      );
      imported += 1;
    }

    await client.query(
      `UPDATE number_import_batches
          SET imported_count = $2, duplicate_count = $3, invalid_count = $4, skipped_count = $5,
              errors = $6::jsonb, status = 'COMPLETED', completed_at = now()
        WHERE id = $1`,
      [id, imported, duplicates, invalid, skippedAssigned, JSON.stringify(errors.slice(0, 200))],
    );

    await writeAudit({
      client,
      actorId: input.actorId,
      actorTelegramId: input.actorTelegramId ?? null,
      actorType: 'ADMIN',
      action: 'NUMBER_IMPORTED',
      targetType: 'number',
      targetId: id,
      targetRef: `${country.name}/${service.name}`,
      metadata: {
        imported,
        duplicates,
        invalid,
        skippedAssigned,
        planType: input.planType,
        source: input.source ?? (input.csvText ? 'CSV' : 'SINGLE'),
      },
    });

    return id;
  });

  logger.info({ batchId, imported, duplicates, invalid, skippedAssigned }, 'number import completed');

  return {
    batchId,
    totalRows: raw.length,
    imported,
    duplicates,
    invalid,
    skippedAssigned,
    errors: errors.slice(0, 200),
  };
}

// -----------------------------------------------------------------------------
// Queries
// -----------------------------------------------------------------------------

export async function getNumberById(id: string): Promise<NumberWithCatalog | null> {
  return one<NumberWithCatalog>(
    `SELECT n.*, c.name AS country_name, c.flag AS country_flag, s.name AS service_name, s.icon AS service_icon
       FROM numbers n JOIN countries c ON c.id = n.country_id JOIN services s ON s.id = n.service_id
      WHERE n.id = $1 AND n.deleted_at IS NULL`,
    [id],
  );
}

export interface NumberFilters {
  countryId?: string;
  serviceId?: string;
  status?: NumberStatus | 'ALL';
  planType?: 'FREE' | 'PREMIUM';
  assignedUserId?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

export async function listNumbers(filters: NumberFilters = {}): Promise<{ rows: NumberWithCatalog[]; total: number }> {
  const params: unknown[] = [];
  const conditions = ['n.deleted_at IS NULL'];
  if (filters.countryId) {
    params.push(filters.countryId);
    conditions.push(`n.country_id = $${params.length}`);
  }
  if (filters.serviceId) {
    params.push(filters.serviceId);
    conditions.push(`n.service_id = $${params.length}`);
  }
  if (filters.status && filters.status !== 'ALL') {
    params.push(filters.status);
    conditions.push(`n.status = $${params.length}`);
  }
  if (filters.planType) {
    params.push(filters.planType);
    conditions.push(`n.plan_type = $${params.length}`);
  }
  if (filters.assignedUserId) {
    params.push(filters.assignedUserId);
    conditions.push(`n.assigned_user_id = $${params.length}`);
  }
  if (filters.search) {
    params.push(`%${filters.search.replace(/\D/g, '')}%`);
    conditions.push(`n.phone_number LIKE $${params.length}`);
  }
  const where = `WHERE ${conditions.join(' AND ')}`;

  const total = await scalar<string>(`SELECT count(*)::text FROM numbers n ${where}`, params);
  const limit = Math.min(filters.limit ?? 10, 50);
  const offset = filters.offset ?? 0;
  params.push(limit, offset);

  const rows = await many<NumberWithCatalog>(
    `SELECT n.*, c.name AS country_name, c.flag AS country_flag, s.name AS service_name, s.icon AS service_icon
       FROM numbers n JOIN countries c ON c.id = n.country_id JOIN services s ON s.id = n.service_id
       ${where}
      ORDER BY n.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return { rows, total: Number(total ?? 0) };
}

export async function listNumbersForUser(userId: string): Promise<NumberWithCatalog[]> {
  return many<NumberWithCatalog>(
    `SELECT n.*, c.name AS country_name, c.flag AS country_flag, s.name AS service_name, s.icon AS service_icon
       FROM numbers n JOIN countries c ON c.id = n.country_id JOIN services s ON s.id = n.service_id
      WHERE n.assigned_user_id = $1 AND n.deleted_at IS NULL AND n.status IN ('ASSIGNED','SUSPENDED','RESERVED')
      ORDER BY n.assigned_at DESC NULLS LAST`,
    [userId],
  );
}

export async function countNumbersByStatus(): Promise<Record<NumberStatus | 'TOTAL', number>> {
  const rows = await many<{ status: string; count: string }>(
    'SELECT status, count(*)::text AS count FROM numbers WHERE deleted_at IS NULL GROUP BY status',
  );
  const out: Record<string, number> = { AVAILABLE: 0, RESERVED: 0, ASSIGNED: 0, SUSPENDED: 0, EXPIRED: 0, DISABLED: 0, TOTAL: 0 };
  for (const r of rows) {
    out[r.status] = Number(r.count);
    out.TOTAL = (out.TOTAL ?? 0) + Number(r.count);
  }
  return out as Record<NumberStatus | 'TOTAL', number>;
}

export async function countNumbersForUser(userId: string): Promise<number> {
  const n = await scalar<string>(
    `SELECT count(*)::text FROM numbers
      WHERE assigned_user_id = $1 AND deleted_at IS NULL AND status IN ('ASSIGNED','SUSPENDED','RESERVED')`,
    [userId],
  );
  return Number(n ?? 0);
}

export async function updateNumber(
  id: string,
  patch: Partial<{ provider: string; planType: 'FREE' | 'PREMIUM'; priceCents: number | null; expirationDate: string | null; status: NumberStatus; serviceId: string }>,
  actor: { actorId: string; requestId?: string | null },
): Promise<NumberRow> {
  return withTransaction(async (client) => {
    const current = await client.query<NumberRow>('SELECT * FROM numbers WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [id]);
    if (!current.rows[0]) throw notFound('Number');

    // Changing the service of an assigned number would silently break routing
    // expectations; require an explicit release first.
    if (patch.serviceId && current.rows[0].status === 'ASSIGNED' && patch.serviceId !== current.rows[0].service_id) {
      throw conflict('Release the number before moving it to a different service.');
    }

    const updated = await client.query<NumberRow>(
      `UPDATE numbers SET
          provider = COALESCE($2, provider),
          plan_type = COALESCE($3, plan_type),
          price_cents = COALESCE($4, price_cents),
          expiration_date = COALESCE($5::date, expiration_date),
          status = COALESCE($6, status),
          service_id = COALESCE($7, service_id)
        WHERE id = $1 RETURNING *`,
      [id, patch.provider ?? null, patch.planType ?? null, patch.priceCents ?? null, patch.expirationDate ?? null, patch.status ?? null, patch.serviceId ?? null],
    );

    await writeAudit({
      client,
      actorId: actor.actorId,
      actorType: 'ADMIN',
      action: 'NUMBER_UPDATED',
      targetType: 'number',
      targetId: id,
      targetRef: maskNumber(current.rows[0].phone_number),
      metadata: { patch },
      requestId: actor.requestId ?? null,
    });

    return updated.rows[0]!;
  });
}

/**
 * Deletes a number from inventory (spec §17).
 * Refuses while the number is assigned unless the caller forces it, in which
 * case the caller must have already released the route.
 */
export async function deleteNumber(
  id: string,
  opts: { actorId: string; force?: boolean; requestId?: string | null },
): Promise<void> {
  await withTransaction(async (client) => {
    const current = await client.query<NumberRow>('SELECT * FROM numbers WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [id]);
    const num = current.rows[0];
    if (!num) throw notFound('Number');
    if (num.assigned_user_id && !opts.force) {
      throw conflict('This number is assigned. Release it first (the route must be removed before the inventory row).');
    }
    const route = await client.query<{ id: string; freepbx_route_id: string | null }>(
      `SELECT id, freepbx_route_id FROM inbound_route_mappings
        WHERE number_id = $1 AND deleted_at IS NULL AND status <> 'REMOVED'`,
      [id],
    );
    if (route.rows[0] && !opts.force) {
      throw conflict('An inbound route still exists for this number. Remove the route first.');
    }

    await client.query(
      `UPDATE inbound_route_mappings SET status = 'REMOVED', deleted_at = now(), last_error = 'number deleted'
        WHERE number_id = $1 AND deleted_at IS NULL`,
      [id],
    );
    // Must run on the transaction's own client: the pool-level query() grabs a
    // second connection which then blocks on the FOR UPDATE lock this TX holds.
    await client.query("UPDATE numbers SET status = 'DISABLED', deleted_at = now() WHERE id = $1", [id]);

    await writeAudit({
      client,
      actorId: opts.actorId,
      actorType: 'ADMIN',
      action: 'NUMBER_DELETED',
      targetType: 'number',
      targetId: id,
      targetRef: maskNumber(num.phone_number),
      metadata: { status: num.status, forced: Boolean(opts.force) },
      requestId: opts.requestId ?? null,
    });
  });
}

/**
 * How much of the inventory a bulk removal would take, and what it must leave
 * alone. Rendered in the admin panel's confirmation screen so nobody wipes more
 * than they meant to (spec §17 - the admin decides, with the numbers in front
 * of them).
 */
export interface RemovalPreview {
  available: number;
  assigned: number;
  suspended: number;
  reserved: number;
  other: number;
}

export async function inventoryRemovalPreview(opts: { countryId?: string; serviceId?: string } = {}): Promise<RemovalPreview> {
  const rows = await many<{ status: string; count: string }>(
    `SELECT status, count(*)::text AS count FROM numbers
      WHERE deleted_at IS NULL
        ${opts.countryId ? 'AND country_id = $1' : ''}
        ${opts.serviceId ? `AND service_id = $${opts.countryId ? 2 : 1}` : ''}
      GROUP BY status`,
    [opts.countryId, opts.serviceId].filter(Boolean),
  );
  const byStatus = new Map(rows.map((r) => [r.status, Number(r.count)]));
  return {
    available: byStatus.get('AVAILABLE') ?? 0,
    assigned: byStatus.get('ASSIGNED') ?? 0,
    suspended: byStatus.get('SUSPENDED') ?? 0,
    reserved: byStatus.get('RESERVED') ?? 0,
    other: (byStatus.get('EXPIRED') ?? 0) + (byStatus.get('DISABLED') ?? 0),
  };
}

/**
 * Removes every AVAILABLE number from the inventory (optionally only those of
 * one country or service).
 *
 * Numbers a user holds are never touched - not even to "free" them: an assigned
 * number still has an inbound route and a person on the other end, so removal
 * stays a two-step operation (release, then delete). Rows are soft-deleted so
 * the audit trail and the DID history survive (spec §28), and any route row that
 * somehow still points at an available number is closed.
 */
export async function removeAllAvailableNumbers(opts: {
  actorId: string;
  countryId?: string;
  serviceId?: string;
  requestId?: string | null;
}): Promise<{ removed: number; kept: RemovalPreview }> {
  return withTransaction(async (client) => {
    const scope: string[] = [];
    const params: unknown[] = [];
    if (opts.countryId) {
      params.push(opts.countryId);
      scope.push(`country_id = $${params.length}`);
    }
    if (opts.serviceId) {
      params.push(opts.serviceId);
      scope.push(`service_id = $${params.length}`);
    }
    const scopeSql = scope.length > 0 ? ` AND ${scope.join(' AND ')}` : '';

    // SKIP LOCKED: a number another transaction is assigning right now is
    // skipped rather than waited for - it is not ours to delete.
    const rows = await client.query<{ id: string }>(
      `SELECT id FROM numbers WHERE status = 'AVAILABLE' AND deleted_at IS NULL${scopeSql} FOR UPDATE SKIP LOCKED`,
      params,
    );
    const ids = rows.rows.map((r) => r.id);

    // Any route row still pointing at one of them is closed, and its PBX-side
    // deletion is queued (idempotent: a missing route is a success).
    let orphanRoutes: string[] = [];
    if (ids.length > 0) {
      const routes = await client.query<{ freepbx_route_id: string | null }>(
        `SELECT freepbx_route_id FROM inbound_route_mappings
          WHERE number_id = ANY($1::uuid[]) AND deleted_at IS NULL AND freepbx_route_id IS NOT NULL`,
        [ids],
      );
      orphanRoutes = routes.rows.map((r) => r.freepbx_route_id).filter((v): v is string => Boolean(v));
      await client.query(
        `UPDATE inbound_route_mappings
            SET status = 'REMOVED', deleted_at = now(), last_error = 'number removed from inventory'
          WHERE number_id = ANY($1::uuid[]) AND deleted_at IS NULL`,
        [ids],
      );
      await client.query(
        "UPDATE numbers SET status = 'DISABLED', status_reason = 'removed by admin', deleted_at = now() WHERE id = ANY($1::uuid[])",
        [ids],
      );
    }

    // What is left: the numbers a user holds, which removal must never take.
    const left = await client.query<{ status: string; count: string }>(
      `SELECT status, count(*)::text AS count FROM numbers WHERE deleted_at IS NULL${scopeSql} GROUP BY status`,
      params,
    );
    const countOf = (status: string) => Number(left.rows.find((r) => r.status === status)?.count ?? 0);
    const kept: RemovalPreview = {
      available: countOf('AVAILABLE'),
      assigned: countOf('ASSIGNED'),
      suspended: countOf('SUSPENDED'),
      reserved: countOf('RESERVED'),
      other: countOf('EXPIRED') + countOf('DISABLED'),
    };

    if (ids.length > 0) {
      await writeAudit({
        client,
        actorId: opts.actorId,
        actorType: 'ADMIN',
        action: 'NUMBER_DELETED',
        targetType: 'number_inventory',
        targetRef: opts.countryId ?? opts.serviceId ?? 'all',
        metadata: {
          bulk: true,
          removed: ids.length,
          scope: { countryId: opts.countryId ?? null, serviceId: opts.serviceId ?? null },
          kept,
        },
        requestId: opts.requestId ?? null,
      });
      logger.warn({ removed: ids.length, kept, scope: opts }, 'bulk removal of available numbers');
    }

    return { removed: ids.length, kept, orphanRoutes };
  }).then(async (outcome) => {
    for (const routeId of outcome.orphanRoutes) {
      await enqueueJob({
        jobType: 'ROUTE_DELETE',
        entityType: 'route',
        idempotencyKey: `route-delete:${routeId}`,
        payload: { routeId, reason: 'number removed from inventory' },
      });
    }
    return { removed: outcome.removed, kept: outcome.kept };
  });
}

/** Numbers whose reservation expired (crashed worker) - returned to AVAILABLE. */
export async function releaseStaleReservations(): Promise<number> {
  const res = await query(
    `UPDATE numbers
        SET status = 'AVAILABLE', reserved_at = NULL, reserved_by = NULL, reservation_expires_at = NULL,
            status_reason = 'reservation expired'
      WHERE status = 'RESERVED' AND reservation_expires_at IS NOT NULL AND reservation_expires_at < now()`,
  );
  const count = res.rowCount ?? 0;
  if (count > 0) logger.warn({ count }, 'released stale number reservations');
  return count;
}

export async function listImportBatches(limit = 5): Promise<Array<Record<string, unknown>>> {
  return many(
    `SELECT b.*, c.name AS country_name, s.name AS service_name
       FROM number_import_batches b
       LEFT JOIN countries c ON c.id = b.country_id
       LEFT JOIN services s ON s.id = b.service_id
      ORDER BY b.created_at DESC LIMIT $1`,
    [limit],
  );
}
