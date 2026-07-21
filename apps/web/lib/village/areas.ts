import { type Database, schema } from '@hale/db';
import { and, asc, eq } from 'drizzle-orm';
import { deriveAreaCoarse } from '~/lib/family/location-input';

/**
 * A family's SAVED coarse areas + the active-region switch behind the Village
 * header. Village content (discover.ts) derives from the ACTIVE area; a family
 * with no rows falls back to the legacy families location fields (back-compat),
 * so nothing changes for a family that never saves an area beyond the 0051
 * backfill.
 *
 * Privacy (rule #1): COARSE only. Every write is family-scoped by the caller's
 * familyId (never the client's), the stored grain is a postal code at finest (the
 * discovery layer derives only its coarse prefix), and precise coordinates are
 * REJECTED at the boundary — the server never accepts or stores a lat/lng. The
 * client resolves "use my current location" to a coarse {city, province} on-device
 * and saves only that; the server treats it identically to a typed city.
 *
 * Audit (rule #6): add and activate each write one immutable audit_log row.
 */

/** The maximum saved areas a family may keep — the switcher stays scannable. */
export const MAX_SAVED_AREAS = 8;

/** Keys whose presence means a payload carried precise coordinates — refused so a
 * lat/lng can never reach the DB (rule #1). Matched case-insensitively. */
const FORBIDDEN_COORDINATE_KEYS = new Set([
  'lat',
  'lng',
  'latitude',
  'longitude',
  'coord',
  'coords',
  'coordinate',
  'coordinates',
  'geo',
  'geolocation',
  'accuracy',
  'altitude',
]);

/** The coarse, client-facing view of one saved area. */
export interface SavedArea {
  id: string;
  city: string;
  province: string | null;
  note: string | null;
  postalCode: string | null;
  isActive: boolean;
  /** ISO instant the area was saved. */
  createdAt: string;
}

/** The active area's human label for the Village header. */
export interface SavedAreaLabel {
  city: string;
  province: string | null;
}

/** The coarse fields a client may save. Precise coordinates are NOT part of the
 * contract and are refused at runtime (rule #1). */
export interface AddAreaInput {
  city: string;
  province?: string;
  note?: string;
  postalCode?: string;
}

export type AddAreaResult =
  | { status: 'added'; area: SavedArea }
  | { status: 'duplicate'; area: SavedArea }
  | { status: 'cap_reached' }
  | { status: 'invalid'; error: 'coordinates_forbidden' | 'city_required' };

export type SetActiveAreaResult = { status: 'activated' } | { status: 'not_found' };

/**
 * True when a raw payload carries any latitude/longitude-shaped key — the signal
 * that a client tried to send precise coordinates. Used to refuse the request
 * before anything is written (rule #1); pure so it is unit-tested directly.
 */
export function hasCoordinateFields(input: Record<string, unknown>): boolean {
  return Object.keys(input).some((key) => FORBIDDEN_COORDINATE_KEYS.has(key.toLowerCase()));
}

function trimToNull(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function toSavedArea(row: {
  id: string;
  city: string;
  province: string | null;
  note: string | null;
  postalCode: string | null;
  isActive: boolean;
  createdAt: Date;
}): SavedArea {
  return {
    id: row.id,
    city: row.city,
    province: row.province,
    note: row.note,
    postalCode: row.postalCode,
    isActive: row.isActive,
    createdAt: row.createdAt.toISOString(),
  };
}

/** All of a family's saved areas, oldest-first (the backfilled "home" leads). */
async function selectAreaRows(database: Database, familyId: string) {
  return database
    .select({
      id: schema.familyAreas.id,
      city: schema.familyAreas.city,
      province: schema.familyAreas.province,
      note: schema.familyAreas.note,
      postalCode: schema.familyAreas.postalCode,
      isActive: schema.familyAreas.isActive,
      createdAt: schema.familyAreas.createdAt,
    })
    .from(schema.familyAreas)
    .where(eq(schema.familyAreas.familyId, familyId))
    .orderBy(asc(schema.familyAreas.createdAt));
}

/** The family's saved areas for the switcher list. Family-scoped (rule #1). */
export async function listAreas(database: Database, familyId: string): Promise<SavedArea[]> {
  const rows = await selectAreaRows(database, familyId);
  return rows.map(toSavedArea);
}

/**
 * Saves a new coarse area for a family. Refuses a payload carrying precise
 * coordinates (rule #1), requires a city, dedupes by (city, province)
 * case-insensitively (returning the existing row, no duplicate), and caps the
 * family at MAX_SAVED_AREAS. A new area is saved INACTIVE — activation is the
 * single exclusivity path (setActiveArea). Audits village_area_added (rule #6).
 */
export async function addArea(
  database: Database,
  args: { familyId: string; userId: string; input: AddAreaInput },
): Promise<AddAreaResult> {
  if (hasCoordinateFields(args.input as unknown as Record<string, unknown>)) {
    return { status: 'invalid', error: 'coordinates_forbidden' };
  }

  const city = trimToNull(args.input.city);
  if (!city) {
    return { status: 'invalid', error: 'city_required' };
  }
  const province = trimToNull(args.input.province);
  const note = trimToNull(args.input.note);
  const postalCode = trimToNull(args.input.postalCode)?.toUpperCase().replace(/\s+/g, ' ') ?? null;

  const existing = await selectAreaRows(database, args.familyId);

  const duplicate = existing.find(
    (row) =>
      row.city.toLowerCase() === city.toLowerCase() &&
      (row.province ?? '').toLowerCase() === (province ?? '').toLowerCase(),
  );
  if (duplicate) {
    return { status: 'duplicate', area: toSavedArea(duplicate) };
  }

  if (existing.length >= MAX_SAVED_AREAS) {
    return { status: 'cap_reached' };
  }

  const area = await database.transaction(async (tx) => {
    const inserted = await tx
      .insert(schema.familyAreas)
      .values({ familyId: args.familyId, city, province, note, postalCode, isActive: false })
      .returning({ id: schema.familyAreas.id, createdAt: schema.familyAreas.createdAt });
    const row = inserted[0];
    if (!row) {
      throw new Error('addArea: family_areas insert returned no row');
    }
    await tx.insert(schema.auditLog).values({
      familyId: args.familyId,
      actor: args.userId,
      actionTaken: 'village_area_added',
      targetTable: 'family_areas',
      targetId: row.id,
      after: { city, province, postalCode, note },
    });
    return toSavedArea({ id: row.id, city, province, note, postalCode, isActive: false, createdAt: row.createdAt });
  });

  return { status: 'added', area };
}

/**
 * Makes one saved area the family's active region — exactly one active per family.
 * Transactional: scoped to the caller's family (a foreign areaId is not_found —
 * cross-family isolation, rule #1), clears every active row, then sets the target
 * active (the DB partial unique index enforces the invariant). Audits
 * village_area_activated (rule #6).
 */
export async function setActiveArea(
  database: Database,
  args: { familyId: string; userId: string; areaId: string },
): Promise<SetActiveAreaResult> {
  return database.transaction(async (tx) => {
    const rows = await tx
      .select({ id: schema.familyAreas.id })
      .from(schema.familyAreas)
      .where(
        and(
          eq(schema.familyAreas.id, args.areaId),
          eq(schema.familyAreas.familyId, args.familyId),
        ),
      )
      .limit(1);
    if (!rows[0]) {
      return { status: 'not_found' };
    }

    await tx
      .update(schema.familyAreas)
      .set({ isActive: false })
      .where(
        and(
          eq(schema.familyAreas.familyId, args.familyId),
          eq(schema.familyAreas.isActive, true),
        ),
      );
    await tx
      .update(schema.familyAreas)
      .set({ isActive: true })
      .where(eq(schema.familyAreas.id, args.areaId));

    await tx.insert(schema.auditLog).values({
      familyId: args.familyId,
      actor: args.userId,
      actionTaken: 'village_area_activated',
      targetTable: 'family_areas',
      targetId: args.areaId,
    });
    return { status: 'activated' };
  });
}

export type RemoveAreaResult =
  | { status: 'removed' }
  | { status: 'not_found' }
  | { status: 'active' };

/**
 * Deletes a saved area for a family. Scoped to the caller's family (a foreign areaId
 * is not_found — cross-family isolation, rule #1) and REFUSES to delete the currently
 * active area (a family must always have an active region — the caller switches away
 * first). Transactional: verify ownership + active-state, delete, then audit
 * village_area_removed (rule #6).
 */
export async function removeArea(
  database: Database,
  args: { familyId: string; userId: string; areaId: string },
): Promise<RemoveAreaResult> {
  return database.transaction(async (tx) => {
    const rows = await tx
      .select({ id: schema.familyAreas.id, isActive: schema.familyAreas.isActive })
      .from(schema.familyAreas)
      .where(
        and(
          eq(schema.familyAreas.id, args.areaId),
          eq(schema.familyAreas.familyId, args.familyId),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) {
      return { status: 'not_found' };
    }
    if (row.isActive) {
      return { status: 'active' };
    }

    await tx.delete(schema.familyAreas).where(eq(schema.familyAreas.id, args.areaId));

    await tx.insert(schema.auditLog).values({
      familyId: args.familyId,
      actor: args.userId,
      actionTaken: 'village_area_removed',
      targetTable: 'family_areas',
      targetId: args.areaId,
    });
    return { status: 'removed' };
  });
}

/** The family's ACTIVE saved area row, or null when none is active. */
async function selectActiveAreaRow(database: Database, familyId: string) {
  const rows = await database
    .select({
      city: schema.familyAreas.city,
      province: schema.familyAreas.province,
      postalCode: schema.familyAreas.postalCode,
    })
    .from(schema.familyAreas)
    .where(and(eq(schema.familyAreas.familyId, familyId), eq(schema.familyAreas.isActive, true)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * The coarse area string village content derives from: the ACTIVE saved area's
 * coarse prefix (rule #1), falling back to the legacy families.area_coarse when
 * the family has no active row (back-compat, no behavior change beyond the
 * backfill). Null when neither is set — the caller treats that as "no area".
 */
export async function resolveActiveAreaCoarse(
  database: Database,
  familyId: string,
): Promise<string | null> {
  const active = await selectActiveAreaRow(database, familyId);
  if (active) {
    return deriveAreaCoarse(active.postalCode, active.city);
  }
  const rows = await database
    .select({ areaCoarse: schema.families.areaCoarse })
    .from(schema.families)
    .where(eq(schema.families.id, familyId))
    .limit(1);
  return rows[0]?.areaCoarse ?? null;
}

/**
 * The active area's human label for the Village header: the ACTIVE saved area's
 * city/province, falling back to the legacy families city/province, null when no
 * city is set anywhere.
 */
export async function readActiveArea(
  database: Database,
  familyId: string,
): Promise<SavedAreaLabel | null> {
  const active = await selectActiveAreaRow(database, familyId);
  if (active) {
    return { city: active.city, province: active.province };
  }
  const rows = await database
    .select({ city: schema.families.city, province: schema.families.province })
    .from(schema.families)
    .where(eq(schema.families.id, familyId))
    .limit(1);
  const family = rows[0];
  return family?.city ? { city: family.city, province: family.province } : null;
}
