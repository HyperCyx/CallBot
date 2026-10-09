import { many, one, query, withTransaction } from '../db/pool.js';
import { AppError, conflict, notFound } from '../lib/errors.js';
import { writeAudit } from './audit.service.js';
import { enqueueJob } from './pbxJob.service.js';
import { enqueueNotification } from './notification.service.js';

/**
 * Catalog: countries, services and plans (spec §8, §9, §22, §25, §26).
 *
 * All of it is database-driven. The Telegram menus are rendered from the
 * results of these queries, so adding a country or a service from the admin
 * panel immediately changes what users can order.
 */

// -----------------------------------------------------------------------------
// Countries
// -----------------------------------------------------------------------------

export interface Country {
  id: string;
  name: string;
  iso2: string;
  iso3: string | null;
  dial_code: string;
  flag: string | null;
  status: 'ACTIVE' | 'DISABLED';
  sort_order: number;
}

export async function listCountries(opts: { activeOnly?: boolean } = {}): Promise<Country[]> {
  return many<Country>(
    `SELECT id, name, iso2, iso3, dial_code, flag, status, sort_order
       FROM countries
      WHERE TRUE ${opts.activeOnly ? "AND status = 'ACTIVE'" : ''}
      ORDER BY sort_order ASC, name ASC`,
  );
}

export async function getCountry(id: string): Promise<Country | null> {
  return one<Country>('SELECT * FROM countries WHERE id = $1 AND deleted_at IS NULL', [id]);
}

export async function createCountry(input: {
  name: string;
  iso2: string;
  iso3?: string;
  dialCode: string;
  flag?: string;
  sortOrder?: number;
}): Promise<Country> {
  const iso2 = input.iso2.toUpperCase();
  const existing = await one<Country>('SELECT * FROM countries WHERE iso2 = $1 AND deleted_at IS NULL', [iso2]);
  if (existing) throw conflict(`A country with ISO2 ${iso2} already exists`);

  // A removed country keeps its row (audit history), so re-adding the same ISO2
  // hits the unique constraint. Revive that row instead: its numbers and offers
  // were removed with it, so they are imported again afterwards.
  const row = await one<Country>(
    `INSERT INTO countries (name, iso2, iso3, dial_code, flag, sort_order, status)
     VALUES ($1,$2,$3,$4,$5,$6,'ACTIVE')
     ON CONFLICT (iso2) DO UPDATE SET
        name = EXCLUDED.name, iso3 = EXCLUDED.iso3, dial_code = EXCLUDED.dial_code,
        flag = EXCLUDED.flag, sort_order = EXCLUDED.sort_order,
        status = 'ACTIVE', deleted_at = NULL
      WHERE countries.deleted_at IS NOT NULL
     RETURNING *`,
    [input.name, iso2, input.iso3?.toUpperCase() ?? null, input.dialCode.replace(/\D/g, ''), input.flag ?? null, input.sortOrder ?? 100],
  );
  if (!row) throw conflict(`A country with ISO2 ${iso2} already exists`);
  return row;
}

export async function updateCountry(id: string, patch: Partial<{ name: string; flag: string; dialCode: string; status: 'ACTIVE' | 'DISABLED'; sortOrder: number }>): Promise<Country> {
  const row = await one<Country>(
    `UPDATE countries SET
        name = COALESCE($2, name),
        flag = COALESCE($3, flag),
        dial_code = COALESCE($4, dial_code),
        status = COALESCE($5, status),
        sort_order = COALESCE($6, sort_order)
      WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
    [id, patch.name ?? null, patch.flag ?? null, patch.dialCode?.replace(/\D/g, '') ?? null, patch.status ?? null, patch.sortOrder ?? null],
  );
  if (!row) throw notFound('Country');
  return row;
}

/**
 * Soft-deletes a country. Numbers referencing it keep working, but the country
 * disappears from the ordering menus, which is the safe behaviour for audit
 * history (spec §17).
 */
/**
 * What removing a catalogue entry would take with it - shown in the admin
 * panel's confirmation screen.
 */
export interface RemovalImpact {
  availableNumbers: number;
  assignedNumbers: number;
  suspendedNumbers: number;
  /** Distinct users holding one of the entry's numbers right now. */
  affectedUsers: number;
  /** Numbers taken back from users by a forced removal. */
  revokedNumbers: number;
  offers: number;
}

export async function countryRemovalImpact(id: string): Promise<RemovalImpact> {
  const numbers = await one<{ available: string; assigned: string; suspended: string; users: string }>(
    `SELECT count(*) FILTER (WHERE status = 'AVAILABLE')::text AS available,
            count(*) FILTER (WHERE status IN ('ASSIGNED','SUSPENDED'))::text AS assigned,
            count(*) FILTER (WHERE status = 'SUSPENDED')::text AS suspended,
            count(DISTINCT assigned_user_id) FILTER (WHERE status IN ('ASSIGNED','SUSPENDED'))::text AS users
       FROM numbers WHERE country_id = $1 AND deleted_at IS NULL`,
    [id],
  );
  const offers = await one<{ count: string }>(
    `SELECT (SELECT count(*) FROM service_countries WHERE country_id = $1)
          + (SELECT count(*) FROM plan_countries WHERE country_id = $1) AS count`,
    [id],
  );
  return {
    availableNumbers: Number(numbers?.available ?? 0),
    assignedNumbers: Number(numbers?.assigned ?? 0),
    suspendedNumbers: Number(numbers?.suspended ?? 0),
    affectedUsers: Number(numbers?.users ?? 0),
    revokedNumbers: 0,
    offers: Number(offers?.count ?? 0),
  };
}

export async function serviceRemovalImpact(id: string): Promise<RemovalImpact> {
  const numbers = await one<{ available: string; assigned: string; suspended: string; users: string }>(
    `SELECT count(*) FILTER (WHERE status = 'AVAILABLE')::text AS available,
            count(*) FILTER (WHERE status IN ('ASSIGNED','SUSPENDED'))::text AS assigned,
            count(*) FILTER (WHERE status = 'SUSPENDED')::text AS suspended,
            count(DISTINCT assigned_user_id) FILTER (WHERE status IN ('ASSIGNED','SUSPENDED'))::text AS users
       FROM numbers WHERE service_id = $1 AND deleted_at IS NULL`,
    [id],
  );
  const offers = await one<{ count: string }>(
    `SELECT (SELECT count(*) FROM service_countries WHERE service_id = $1)
          + (SELECT count(*) FROM plan_services WHERE service_id = $1) AS count`,
    [id],
  );
  return {
    availableNumbers: Number(numbers?.available ?? 0),
    assignedNumbers: Number(numbers?.assigned ?? 0),
    suspendedNumbers: Number(numbers?.suspended ?? 0),
    affectedUsers: Number(numbers?.users ?? 0),
    revokedNumbers: 0,
    offers: Number(offers?.count ?? 0),
  };
}

/**
 * Removes a country from the catalogue.
 *
 * Refused while a user still holds one of its numbers (release first - a live
 * route must not lose its country). Otherwise the whole entry goes: its
 * available numbers are removed from the inventory, its per-service and
 * per-plan offers are dropped, and the country is soft-deleted so history and
 * the audit trail survive (spec §28).
 */
/**
 * Removes a country from the catalogue.
 *
 * Without `force` it refuses while a user still holds one of its numbers - a
 * live number must not lose its country by accident. With `force`, which the
 * admin panel asks for explicitly after showing what it will take, those
 * numbers are revoked first: each is released from its holder (inbound route
 * removed first, then the row retired) and the holder is notified. Then the
 * whole entry goes: every number of the country is removed from the inventory,
 * its offers are dropped, and the country is soft-deleted so history and the
 * audit trail survive (spec §28).
 */
export async function deleteCountry(
  id: string,
  opts: { actorId?: string; requestId?: string | null; force?: boolean } = {},
): Promise<RemovalImpact> {
  const country = await one<{ name: string }>('SELECT name FROM countries WHERE id = $1 AND deleted_at IS NULL', [id]);
  if (!country) throw notFound('Country');

  const impact = await countryRemovalImpact(id);
  if (impact.assignedNumbers > 0 && !opts.force) {
    throw conflict(
      `This country still has ${impact.assignedNumbers} number(s) in use by ${impact.affectedUsers} user(s). Release or reassign them first - or remove it with force, which revokes those numbers from their holders.`,
    );
  }

  // Revoking removes a PBX route per number, so it runs OUTSIDE the
  // transaction (network I/O must not hold row locks). The import is dynamic
  // because the assignment service already depends on this module.
  const { releaseNumber } = await import('./assignment.service.js');
  const inUse = await many<{ id: string; phone_number: string; assigned_user_id: string | null; status: string }>(
    `SELECT id, phone_number, assigned_user_id, status FROM numbers
      WHERE country_id = $1 AND deleted_at IS NULL AND status IN ('ASSIGNED','SUSPENDED','RESERVED')
      ORDER BY assigned_at NULLS LAST`,
    [id],
  );

  const holders = new Map<string, string>(); // userId -> phone number they lost
  for (const number of inUse) {
    await releaseNumber(number.id, {
      actorId: opts.actorId ?? 'system',
      actorType: 'ADMIN',
      reason: 'country removed by admin',
      resultingStatus: 'DISABLED',
      requestId: opts.requestId ?? null,
    });
    if (number.assigned_user_id) holders.set(number.assigned_user_id, number.phone_number);
  }

  const result = await withTransaction(async (client) => {
    const orphanRoutes = (
      await client.query<{ freepbx_route_id: string }>(
        `SELECT freepbx_route_id FROM inbound_route_mappings
          WHERE number_id IN (SELECT id FROM numbers WHERE country_id = $1)
            AND deleted_at IS NULL AND freepbx_route_id IS NOT NULL`,
        [id],
      )
    ).rows.map((r) => r.freepbx_route_id);

    // Every number goes, whatever its status: the catalogue entry that gave it
    // a country no longer exists.
    await client.query(
      `UPDATE numbers SET status = 'DISABLED', status_reason = 'country removed by admin', deleted_at = now()
        WHERE country_id = $1 AND deleted_at IS NULL`,
      [id],
    );
    await client.query(
      `UPDATE inbound_route_mappings SET status = 'REMOVED', deleted_at = now(), last_error = 'country removed by admin'
        WHERE number_id IN (SELECT id FROM numbers WHERE country_id = $1) AND deleted_at IS NULL`,
      [id],
    );
    const offers = await client.query('DELETE FROM service_countries WHERE country_id = $1', [id]);
    const planOffers = await client.query('DELETE FROM plan_countries WHERE country_id = $1', [id]);
    await client.query("UPDATE countries SET status = 'DISABLED', deleted_at = now() WHERE id = $1", [id]);

    const removal: RemovalImpact = {
      availableNumbers: impact.availableNumbers,
      assignedNumbers: 0,
      suspendedNumbers: 0,
      affectedUsers: holders.size,
      revokedNumbers: inUse.length,
      offers: (offers.rowCount ?? 0) + (planOffers.rowCount ?? 0),
    };

    // Queue the PBX-side route deletions (idempotent: a missing route is fine).
    for (const routeId of orphanRoutes) {
      await enqueueJob({
        jobType: 'ROUTE_DELETE',
        entityType: 'route',
        idempotencyKey: `route-delete:${routeId}`,
        payload: { routeId, reason: 'country removed by admin' },
      });
    }

    await writeAudit({
      client,
      actorId: opts.actorId ?? null,
      actorType: 'ADMIN',
      action: 'COUNTRY_DELETED',
      targetType: 'country',
      targetId: id,
      targetRef: country.name,
      metadata: { ...removal },
      requestId: opts.requestId ?? null,
    });

    return removal;
  });

  // Tell the people whose numbers just went away (queued, so a crash here
  // cannot lose the message).
  for (const [userId, phoneNumber] of holders) {
    await enqueueNotification({
      userId,
      kind: 'NUMBER_RELEASED',
      payload: {
        phoneNumber,
        note: `This number was removed because ${country.name} was removed from the catalogue. Contact support if you need a replacement.`,
      },
      dedupeKey: `country-removed:${id}:${userId}`,
    });
  }

  return result;
}

// -----------------------------------------------------------------------------
// Services
// -----------------------------------------------------------------------------

export interface Service {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  icon: string | null;
  status: 'ACTIVE' | 'DISABLED';
  sort_order: number;
}

export async function listServices(opts: { activeOnly?: boolean } = {}): Promise<Service[]> {
  return many<Service>(
    `SELECT id, slug, name, description, icon, status, sort_order FROM services
      WHERE TRUE ${opts.activeOnly ? "AND status = 'ACTIVE'" : ''}
      ORDER BY sort_order ASC, name ASC`,
  );
}

export async function getService(id: string): Promise<Service | null> {
  return one<Service>('SELECT * FROM services WHERE id = $1 AND deleted_at IS NULL', [id]);
}

export async function createService(input: {
  name: string;
  slug?: string;
  description?: string;
  icon?: string;
  sortOrder?: number;
}): Promise<Service> {
  const slug = (input.slug ?? input.name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
  const existing = await one<Service>('SELECT * FROM services WHERE slug = $1 AND deleted_at IS NULL', [slug]);
  if (existing) throw conflict(`A service with slug "${slug}" already exists`);

  // Same revival rule as countries: re-adding a removed service brings its row
  // back rather than failing on the unique slug.
  const row = await one<Service>(
    `INSERT INTO services (slug, name, description, icon, sort_order, status)
     VALUES ($1,$2,$3,$4,$5,'ACTIVE')
     ON CONFLICT (slug) DO UPDATE SET
        name = EXCLUDED.name, description = EXCLUDED.description,
        icon = EXCLUDED.icon, sort_order = EXCLUDED.sort_order,
        status = 'ACTIVE', deleted_at = NULL
      WHERE services.deleted_at IS NOT NULL
     RETURNING *`,
    [slug, input.name, input.description ?? null, input.icon ?? null, input.sortOrder ?? 100],
  );
  if (!row) throw conflict(`A service with slug "${slug}" already exists`);
  return row;
}

export async function updateService(id: string, patch: Partial<{ name: string; description: string; icon: string; status: 'ACTIVE' | 'DISABLED'; sortOrder: number }>): Promise<Service> {
  const row = await one<Service>(
    `UPDATE services SET
        name = COALESCE($2, name),
        description = COALESCE($3, description),
        icon = COALESCE($4, icon),
        status = COALESCE($5, status),
        sort_order = COALESCE($6, sort_order)
      WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
    [id, patch.name ?? null, patch.description ?? null, patch.icon ?? null, patch.status ?? null, patch.sortOrder ?? null],
  );
  if (!row) throw notFound('Service');
  return row;
}

/**
 * Removes a service from the catalogue (spec §9).
 *
 * Refused while a user holds one of its numbers. Otherwise its available
 * numbers go with it, its offers are dropped, and the service is soft-deleted.
 */
/**
 * Removes a service from the catalogue. Mirrors deleteCountry: `force` revokes
 * the numbers users hold (route removed, holder notified) instead of refusing.
 */
export async function deleteService(
  id: string,
  opts: { actorId?: string; requestId?: string | null; force?: boolean } = {},
): Promise<RemovalImpact> {
  const service = await one<{ name: string }>('SELECT name FROM services WHERE id = $1 AND deleted_at IS NULL', [id]);
  if (!service) throw notFound('Service');

  const impact = await serviceRemovalImpact(id);
  if (impact.assignedNumbers > 0 && !opts.force) {
    throw conflict(
      `This service still has ${impact.assignedNumbers} number(s) in use by ${impact.affectedUsers} user(s). Release or reassign them first - or remove it with force, which revokes those numbers from their holders.`,
    );
  }

  const { releaseNumber } = await import('./assignment.service.js');
  const inUse = await many<{ id: string; phone_number: string; assigned_user_id: string | null; status: string }>(
    `SELECT id, phone_number, assigned_user_id, status FROM numbers
      WHERE service_id = $1 AND deleted_at IS NULL AND status IN ('ASSIGNED','SUSPENDED','RESERVED')
      ORDER BY assigned_at NULLS LAST`,
    [id],
  );

  const holders = new Map<string, string>();
  for (const number of inUse) {
    await releaseNumber(number.id, {
      actorId: opts.actorId ?? 'system',
      actorType: 'ADMIN',
      reason: 'service removed by admin',
      resultingStatus: 'DISABLED',
      requestId: opts.requestId ?? null,
    });
    if (number.assigned_user_id) holders.set(number.assigned_user_id, number.phone_number);
  }

  const result = await withTransaction(async (client) => {
    const orphanRoutes = (
      await client.query<{ freepbx_route_id: string }>(
        `SELECT freepbx_route_id FROM inbound_route_mappings
          WHERE number_id IN (SELECT id FROM numbers WHERE service_id = $1)
            AND deleted_at IS NULL AND freepbx_route_id IS NOT NULL`,
        [id],
      )
    ).rows.map((r) => r.freepbx_route_id);

    await client.query(
      `UPDATE numbers SET status = 'DISABLED', status_reason = 'service removed by admin', deleted_at = now()
        WHERE service_id = $1 AND deleted_at IS NULL`,
      [id],
    );
    await client.query(
      `UPDATE inbound_route_mappings SET status = 'REMOVED', deleted_at = now(), last_error = 'service removed by admin'
        WHERE number_id IN (SELECT id FROM numbers WHERE service_id = $1) AND deleted_at IS NULL`,
      [id],
    );
    const offers = await client.query('DELETE FROM service_countries WHERE service_id = $1', [id]);
    const planOffers = await client.query('DELETE FROM plan_services WHERE service_id = $1', [id]);
    await client.query("UPDATE services SET status = 'DISABLED', deleted_at = now() WHERE id = $1", [id]);

    const removal: RemovalImpact = {
      availableNumbers: impact.availableNumbers,
      assignedNumbers: 0,
      suspendedNumbers: 0,
      affectedUsers: holders.size,
      revokedNumbers: inUse.length,
      offers: (offers.rowCount ?? 0) + (planOffers.rowCount ?? 0),
    };

    for (const routeId of orphanRoutes) {
      await enqueueJob({
        jobType: 'ROUTE_DELETE',
        entityType: 'route',
        idempotencyKey: `route-delete:${routeId}`,
        payload: { routeId, reason: 'service removed by admin' },
      });
    }

    await writeAudit({
      client,
      actorId: opts.actorId ?? null,
      actorType: 'ADMIN',
      action: 'SERVICE_DELETED',
      targetType: 'service',
      targetId: id,
      targetRef: service.name,
      metadata: { ...removal },
      requestId: opts.requestId ?? null,
    });

    return removal;
  });

  for (const [userId, phoneNumber] of holders) {
    await enqueueNotification({
      userId,
      kind: 'NUMBER_RELEASED',
      payload: {
        phoneNumber,
        note: `This number was removed because the ${service.name} service was removed from the catalogue. Contact support if you need a replacement.`,
      },
      dedupeKey: `service-removed:${id}:${userId}`,
    });
  }

  return result;
}

/** Per-country availability + pricing for a service (spec §25 "Inventory rules"). */
export interface ServiceCountry {
  id: string;
  service_id: string;
  country_id: string;
  status: 'ACTIVE' | 'DISABLED';
  price_cents: number | null;
  currency: string;
  max_per_user: number | null;
  requires_premium: boolean;
}

export async function upsertServiceCountry(input: {
  serviceId: string;
  countryId: string;
  priceCents?: number | null;
  currency?: string;
  maxPerUser?: number | null;
  requiresPremium?: boolean;
  status?: 'ACTIVE' | 'DISABLED';
}): Promise<ServiceCountry> {
  const row = await one<ServiceCountry>(
    `INSERT INTO service_countries (service_id, country_id, price_cents, currency, max_per_user, requires_premium, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (service_id, country_id) DO UPDATE SET
        price_cents = EXCLUDED.price_cents,
        currency = EXCLUDED.currency,
        max_per_user = EXCLUDED.max_per_user,
        requires_premium = EXCLUDED.requires_premium,
        status = EXCLUDED.status
     RETURNING *`,
    [
      input.serviceId,
      input.countryId,
      input.priceCents ?? null,
      input.currency ?? 'USD',
      input.maxPerUser ?? null,
      input.requiresPremium ?? false,
      input.status ?? 'ACTIVE',
    ],
  );
  return row!;
}

/**
 * Countries that actually have something to sell, optionally filtered by the
 * user's plan. This is what the "🌍 Select Country" screen shows - never a
 * hard-coded list (spec §8).
 */
export interface OfferCountry {
  id: string;
  name: string;
  flag: string | null;
  dial_code: string;
  available_count: number;
  services_count: number;
  /** Cheapest paid offer price across active service offers for this country; NULL when every offer is free. */
  min_price_cents: number | null;
  max_price_cents: number | null;
  price_currency: string;
}

export async function listOfferCountries(opts: { planId?: string | null; includeEmpty?: boolean } = {}): Promise<OfferCountry[]> {
  // Paid/free is written ON the country picker line (operator decision):
  // the price comes from that country's ACTIVE service offers, so "paid"
  // appears even before the user opens the service list.
  return many<OfferCountry>(
    `SELECT c.id, c.name, c.flag, c.dial_code,
            count(*) FILTER (WHERE n.status = 'AVAILABLE')::int AS available_count,
            count(DISTINCT n.service_id)::int AS services_count,
            min(sc.price_cents) FILTER (WHERE sc.price_cents > 0) AS min_price_cents,
            max(sc.price_cents) FILTER (WHERE sc.price_cents > 0) AS max_price_cents,
            COALESCE((array_agg(sc.currency) FILTER (WHERE sc.price_cents > 0))[1], 'USD') AS price_currency
       FROM countries c
       JOIN numbers n ON n.country_id = c.id AND n.deleted_at IS NULL
       JOIN services s ON s.id = n.service_id AND s.status = 'ACTIVE' AND s.deleted_at IS NULL
       LEFT JOIN service_countries sc ON sc.country_id = c.id AND sc.status = 'ACTIVE' AND sc.price_cents > 0
       LEFT JOIN plan_countries pc ON pc.country_id = c.id AND pc.plan_id = $1
      WHERE c.status = 'ACTIVE' AND c.deleted_at IS NULL
        AND ($2::boolean OR n.status = 'AVAILABLE')
        AND ($1::uuid IS NULL OR pc.allowed IS NULL OR pc.allowed = true)
      GROUP BY c.id, c.name, c.flag, c.dial_code, c.sort_order
      HAVING count(*) FILTER (WHERE n.status = 'AVAILABLE') > 0 OR $2::boolean
      ORDER BY c.sort_order ASC, c.name ASC`,
    [opts.planId ?? null, opts.includeEmpty ?? false],
  );
}

/**
 * What will actually be charged for number `numberId` given service/country:
 * an explicit per-number price overrides the country offer, no offer = free.
 */
export async function effectivePriceForOffer(
  opts: { numberId: string; countryId: string; serviceId: string },
  client?: Pick<import('../db/pool.js').DbClient, 'query'>,
): Promise<{ cents: number; currency: string }> {
  const read = async () => one<{ cents: number | null; currency: string }>(
    `SELECT COALESCE(
              (SELECT price_cents FROM numbers WHERE id = $1),
              (SELECT price_cents FROM service_countries
                WHERE country_id = $2 AND service_id = $3 AND status = 'ACTIVE'
                LIMIT 1)
            ) AS cents,
            COALESCE(
              (SELECT currency FROM service_countries
                WHERE country_id = $2 AND service_id = $3 AND status = 'ACTIVE'
                LIMIT 1),
              'USD'
            ) AS currency`,
    [opts.numberId, opts.countryId, opts.serviceId],
  );
  if (client) {
    const inline = await client.query<{ cents: number | null; currency: string }>(
      `SELECT COALESCE(
                (SELECT price_cents FROM numbers WHERE id = $1),
                (SELECT price_cents FROM service_countries
                  WHERE country_id = $2 AND service_id = $3 AND status = 'ACTIVE'
                  LIMIT 1)
              ) AS cents,
              COALESCE(
                (SELECT currency FROM service_countries
                  WHERE country_id = $2 AND service_id = $3 AND status = 'ACTIVE'
                  LIMIT 1),
                'USD'
              ) AS currency`,
      [opts.numberId, opts.countryId, opts.serviceId],
    );
    const row = inline.rows[0];
    return { cents: row?.cents ?? 0, currency: row?.currency ?? 'USD' };
  }
  const row = await read();
  return { cents: row?.cents ?? 0, currency: row?.currency ?? 'USD' };
}

/** Services available for a country, with live availability counts. */
export interface OfferService {
  id: string;
  name: string;
  icon: string | null;
  available_count: number;
  price_cents: number | null;
  currency: string;
  requires_premium: boolean;
}

export async function listOfferServices(opts: {
  countryId: string;
  planId?: string | null;
  includeEmpty?: boolean;
}): Promise<OfferService[]> {
  return many<OfferService>(
    `SELECT s.id, s.name, s.icon,
            count(*) FILTER (WHERE n.status = 'AVAILABLE')::int AS available_count,
            sc.price_cents, COALESCE(sc.currency, 'USD') AS currency,
            COALESCE(sc.requires_premium, false) AS requires_premium
       FROM services s
       JOIN numbers n ON n.service_id = s.id AND n.country_id = $1 AND n.deleted_at IS NULL
       LEFT JOIN plan_services ps ON ps.service_id = s.id AND ps.plan_id = $2
       LEFT JOIN service_countries sc ON sc.service_id = s.id AND sc.country_id = $1
      WHERE s.status = 'ACTIVE' AND s.deleted_at IS NULL
        AND ($3::boolean OR n.status = 'AVAILABLE')
        AND ($2::uuid IS NULL OR ps.allowed IS NULL OR ps.allowed = true)
      GROUP BY s.id, s.name, s.icon, s.sort_order, sc.price_cents, sc.currency, sc.requires_premium
      ORDER BY s.sort_order ASC, s.name ASC`,
    [opts.countryId, opts.planId ?? null, opts.includeEmpty ?? false],
  );
}

// -----------------------------------------------------------------------------
// Plans
// -----------------------------------------------------------------------------

export interface Plan {
  id: string;
  code: string;
  name: string;
  description: string | null;
  is_active: boolean;
  is_default: boolean;
  rank: number;
  max_numbers: number;
  max_numbers_per_country: number | null;
  allows_premium_numbers: boolean;
  allows_test_number: boolean;
  price_cents_per_month: number;
  currency: string;
  duration_days: number;
  number_expiry_days: number | null;
  features: Record<string, unknown>;
}

export async function listPlans(opts: { activeOnly?: boolean } = {}): Promise<Plan[]> {
  return many<Plan>(
    `SELECT * FROM plans WHERE TRUE ${opts.activeOnly ? 'AND is_active' : ''} ORDER BY rank DESC, name ASC`,
  );
}

export async function getPlan(id: string): Promise<Plan | null> {
  return one<Plan>('SELECT * FROM plans WHERE id = $1 AND deleted_at IS NULL', [id]);
}

export async function getPlanByCode(code: string): Promise<Plan | null> {
  return one<Plan>('SELECT * FROM plans WHERE code = $1 AND deleted_at IS NULL', [code]);
}

export async function getDefaultPlan(): Promise<Plan | null> {
  return one<Plan>('SELECT * FROM plans WHERE is_default = true AND deleted_at IS NULL LIMIT 1');
}

export async function createPlan(input: {
  code: string;
  name: string;
  description?: string;
  rank?: number;
  maxNumbers?: number;
  allowsPremiumNumbers?: boolean;
  priceCentsPerMonth?: number;
  currency?: string;
  durationDays?: number;
  features?: Record<string, unknown>;
}): Promise<Plan> {
  const existing = await getPlanByCode(input.code);
  if (existing) throw conflict(`Plan code "${input.code}" already exists`);
  const row = await one<Plan>(
    `INSERT INTO plans (code, name, description, rank, max_numbers, allows_premium_numbers,
                        price_cents_per_month, currency, duration_days, features)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) RETURNING *`,
    [
      input.code,
      input.name,
      input.description ?? null,
      input.rank ?? 0,
      input.maxNumbers ?? 1,
      input.allowsPremiumNumbers ?? false,
      input.priceCentsPerMonth ?? 0,
      input.currency ?? 'USD',
      input.durationDays ?? 30,
      JSON.stringify(input.features ?? {}),
    ],
  );
  return row!;
}

export async function updatePlan(
  id: string,
  patch: Partial<{
    name: string;
    description: string;
    rank: number;
    maxNumbers: number;
    allowsPremiumNumbers: boolean;
    priceCentsPerMonth: number;
    durationDays: number;
    isActive: boolean;
  }>,
): Promise<Plan> {
  const row = await one<Plan>(
    `UPDATE plans SET
        name = COALESCE($2, name),
        description = COALESCE($3, description),
        rank = COALESCE($4, rank),
        max_numbers = COALESCE($5, max_numbers),
        allows_premium_numbers = COALESCE($6, allows_premium_numbers),
        price_cents_per_month = COALESCE($7, price_cents_per_month),
        duration_days = COALESCE($8, duration_days),
        is_active = COALESCE($9, is_active)
      WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
    [
      id,
      patch.name ?? null,
      patch.description ?? null,
      patch.rank ?? null,
      patch.maxNumbers ?? null,
      patch.allowsPremiumNumbers ?? null,
      patch.priceCentsPerMonth ?? null,
      patch.durationDays ?? null,
      patch.isActive ?? null,
    ],
  );
  if (!row) throw notFound('Plan');
  return row;
}

export async function setPlanAccess(planId: string, kind: 'country' | 'service', targetId: string, allowed: boolean): Promise<void> {
  if (kind === 'country') {
    await query(
      `INSERT INTO plan_countries (plan_id, country_id, allowed) VALUES ($1,$2,$3)
       ON CONFLICT (plan_id, country_id) DO UPDATE SET allowed = EXCLUDED.allowed`,
      [planId, targetId, allowed],
    );
  } else {
    await query(
      `INSERT INTO plan_services (plan_id, service_id, allowed) VALUES ($1,$2,$3)
       ON CONFLICT (plan_id, service_id) DO UPDATE SET allowed = EXCLUDED.allowed`,
      [planId, targetId, allowed],
    );
  }
}

/**
 * Whether a user may take one more number (spec §22).
 * Rules come from the plan row; nothing is hard-coded.
 */
export interface PlanCheckResult {
  allowed: boolean;
  reason?: string;
  code?: 'PLAN_LIMIT' | 'PLAN_PREMIUM_ONLY' | 'PLAN_COUNTRY_BLOCKED' | 'PLAN_SERVICE_BLOCKED';
  /** The plan's allowance, so callers can offer to replace instead of refusing. */
  limit?: number;
}

export async function checkPlanAllowsNumber(opts: {
  planId: string | null;
  userId: string;
  countryId: string;
  serviceId: string;
  planType: 'FREE' | 'PREMIUM';
  currentCount: number;
}): Promise<PlanCheckResult> {
  const plan = opts.planId ? await getPlan(opts.planId) : await getDefaultPlan();
  if (!plan) return { allowed: false, reason: 'No active plan is configured. Contact support.', code: 'PLAN_LIMIT' };

  if (opts.currentCount >= plan.max_numbers) {
    return {
      allowed: false,
      reason: `Your plan (${plan.name}) allows ${plan.max_numbers} number(s). Release one or upgrade your plan.`,
      code: 'PLAN_LIMIT',
      limit: plan.max_numbers,
    };
  }
  if (opts.planType === 'PREMIUM' && !plan.allows_premium_numbers) {
    return { allowed: false, reason: 'This number requires a Premium plan.', code: 'PLAN_PREMIUM_ONLY' };
  }

  const countryRule = await one<{ allowed: boolean; max_numbers: number | null }>(
    'SELECT allowed, max_numbers FROM plan_countries WHERE plan_id = $1 AND country_id = $2',
    [plan.id, opts.countryId],
  );
  if (countryRule && countryRule.allowed === false) {
    return { allowed: false, reason: 'Your plan does not include numbers from this country.', code: 'PLAN_COUNTRY_BLOCKED' };
  }

  const serviceRule = await one<{ allowed: boolean; max_numbers: number | null }>(
    'SELECT allowed, max_numbers FROM plan_services WHERE plan_id = $1 AND service_id = $2',
    [plan.id, opts.serviceId],
  );
  if (serviceRule && serviceRule.allowed === false) {
    return { allowed: false, reason: 'Your plan does not include this service.', code: 'PLAN_SERVICE_BLOCKED' };
  }

  return { allowed: true };
}
