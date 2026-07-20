import { schema } from '@hale/db';
import { describe, expect, it } from 'vitest';
import {
  addArea,
  hasCoordinateFields,
  listAreas,
  readActiveArea,
  resolveActiveAreaCoarse,
  setActiveArea,
} from './areas.js';

const FAMILY_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_FAMILY_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '55555555-5555-4555-8555-555555555555';
const AREA_ID = '44444444-4444-4444-8444-444444444444';

interface AreaRow {
  id: string;
  familyId: string;
  city: string;
  province: string | null;
  note: string | null;
  postalCode: string | null;
  isActive: boolean;
  createdAt: Date;
}

interface Capture {
  inserts: Array<{ table: unknown; rows: Record<string, unknown>[] }>;
  updates: Array<{ table: unknown; payload: Record<string, unknown> }>;
}

/**
 * A table-routed fake db covering the exact chains areas.ts runs, with NO real db:
 *   - select().from(familyAreas).where().orderBy()  → `areaRows` (list + dedupe/cap)
 *   - select().from(familyAreas).where().limit(1)   → `limitRows` (active-read OR by-id
 *                                                     lookup — per-test meaning)
 *   - select({...}).from(families).where().limit(1) → [`family`] (legacy fallback)
 *   - insert(table).values(rows)[.returning()]      → captured; returning → `inserted`
 *   - update(table).set(payload).where()            → captured
 *   - transaction(cb)                               → cb(handler) (same handler as tx)
 */
function fakeDb(store: {
  areaRows?: AreaRow[];
  limitRows?: AreaRow[];
  family?: { areaCoarse?: string | null; city?: string | null; province?: string | null };
  inserted?: Array<Record<string, unknown>>;
}) {
  const capture: Capture = { inserts: [], updates: [] };

  const select = () => {
    let tbl: unknown;
    const builder = {
      from(t: unknown) {
        tbl = t;
        return builder;
      },
      where() {
        return builder;
      },
      orderBy() {
        return Promise.resolve(tbl === schema.familyAreas ? (store.areaRows ?? []) : []);
      },
      limit() {
        if (tbl === schema.familyAreas) return Promise.resolve(store.limitRows ?? []);
        if (tbl === schema.families) return Promise.resolve(store.family ? [store.family] : []);
        return Promise.resolve([]);
      },
    };
    return builder;
  };

  const insert = (table: unknown) => ({
    values(rows: unknown) {
      const list = (Array.isArray(rows) ? rows : [rows]) as Record<string, unknown>[];
      capture.inserts.push({ table, rows: list });
      const p = Promise.resolve(undefined) as Promise<undefined> & {
        returning: () => Promise<Array<Record<string, unknown>>>;
      };
      p.returning = () => Promise.resolve(store.inserted ?? []);
      return p;
    },
  });

  const update = (table: unknown) => ({
    set(payload: Record<string, unknown>) {
      capture.updates.push({ table, payload });
      return { where: () => Promise.resolve(undefined) };
    },
  });

  const handler = {
    select,
    insert,
    update,
    transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(handler),
  };

  return { db: handler as never, capture };
}

describe('hasCoordinateFields — never accept precise coordinates (rule #1)', () => {
  it('flags any latitude/longitude-shaped key, case-insensitively', () => {
    expect(hasCoordinateFields({ city: 'Toronto', lat: 43.6 })).toBe(true);
    expect(hasCoordinateFields({ city: 'Toronto', lng: -79.4 })).toBe(true);
    expect(hasCoordinateFields({ city: 'Toronto', Latitude: 43.6 })).toBe(true);
    expect(hasCoordinateFields({ city: 'Toronto', LONGITUDE: -79.4 })).toBe(true);
    expect(hasCoordinateFields({ city: 'Toronto', coords: {} })).toBe(true);
    expect(hasCoordinateFields({ city: 'Toronto', coordinates: [] })).toBe(true);
  });

  it('passes a clean coarse payload', () => {
    expect(
      hasCoordinateFields({ city: 'Toronto', province: 'ON', note: 'home', postalCode: 'M5V 2T6' }),
    ).toBe(false);
  });
});

describe('addArea — dedupe, cap, coarse-only (rules #1/#6)', () => {
  it('REJECTS a payload carrying lat/lng and never persists it (rule #1)', async () => {
    const { db, capture } = fakeDb({ areaRows: [] });
    const result = await addArea(db, {
      familyId: FAMILY_ID,
      userId: USER_ID,
      // A malicious/buggy client sends precise coordinates alongside the coarse city.
      input: { city: 'Toronto', province: 'ON', lat: 43.6532, lng: -79.3832 } as never,
    });
    expect(result).toEqual({ status: 'invalid', error: 'coordinates_forbidden' });
    // Nothing was written — lat/lng can never reach the DB.
    expect(capture.inserts).toEqual([]);
  });

  it('inserts ONLY the coarse whitelist columns, family-scoped to the caller (never a coord column)', async () => {
    const { db, capture } = fakeDb({
      areaRows: [],
      inserted: [{ id: AREA_ID, createdAt: new Date('2026-07-19T00:00:00Z') }],
    });
    const result = await addArea(db, {
      familyId: FAMILY_ID,
      userId: USER_ID,
      input: { city: '  Toronto ', province: 'on', note: 'home', postalCode: 'm5v 2t6' },
    });

    expect(result.status).toBe('added');
    const areaInsert = capture.inserts.find((i) => i.table === schema.familyAreas);
    expect(areaInsert).toBeDefined();
    const row = areaInsert?.rows[0] as Record<string, unknown>;
    // The row carries exactly the coarse columns — no lat/lng column exists.
    expect(Object.keys(row).sort()).toEqual(
      ['city', 'familyId', 'isActive', 'note', 'postalCode', 'province'].sort(),
    );
    // Family-scoped to the CALLER (rule #1), trimmed + normalized, never auto-active.
    expect(row.familyId).toBe(FAMILY_ID);
    expect(row.city).toBe('Toronto');
    expect(row.province).toBe('on');
    expect(row.postalCode).toBe('M5V 2T6');
    expect(row.isActive).toBe(false);
    // Rule #6: an immutable audit row for the add.
    const audit = capture.inserts.find((i) => i.table === schema.auditLog);
    expect(audit?.rows[0]).toEqual(
      expect.objectContaining({
        familyId: FAMILY_ID,
        actor: USER_ID,
        actionTaken: 'village_area_added',
        targetTable: 'family_areas',
        targetId: AREA_ID,
      }),
    );
  });

  it('DEDUPES by (city, province) case-insensitively — returns the existing row, inserts nothing', async () => {
    const existing: AreaRow = {
      id: AREA_ID,
      familyId: FAMILY_ID,
      city: 'Toronto',
      province: 'ON',
      note: 'home',
      postalCode: 'M5V 2T6',
      isActive: true,
      createdAt: new Date('2026-07-01T00:00:00Z'),
    };
    const { db, capture } = fakeDb({ areaRows: [existing] });
    const result = await addArea(db, {
      familyId: FAMILY_ID,
      userId: USER_ID,
      input: { city: 'toronto', province: 'on' },
    });
    expect(result.status).toBe('duplicate');
    expect(capture.inserts).toEqual([]);
  });

  it('CAPS the saved areas at 8 — a 9th add is refused, nothing written', async () => {
    const rows: AreaRow[] = Array.from({ length: 8 }, (_, i) => ({
      id: `area-${i}`,
      familyId: FAMILY_ID,
      city: `City${i}`,
      province: 'ON',
      note: null,
      postalCode: null,
      isActive: i === 0,
      createdAt: new Date(),
    }));
    const { db, capture } = fakeDb({ areaRows: rows });
    const result = await addArea(db, {
      familyId: FAMILY_ID,
      userId: USER_ID,
      input: { city: 'Ninth', province: 'ON' },
    });
    expect(result).toEqual({ status: 'cap_reached' });
    expect(capture.inserts).toEqual([]);
  });

  it('rejects a blank city', async () => {
    const { db, capture } = fakeDb({ areaRows: [] });
    const result = await addArea(db, {
      familyId: FAMILY_ID,
      userId: USER_ID,
      input: { city: '   ' },
    });
    expect(result).toEqual({ status: 'invalid', error: 'city_required' });
    expect(capture.inserts).toEqual([]);
  });
});

describe('setActiveArea — exactly one active per family (transactional, rule #6)', () => {
  it('clears every active row then sets the target active, and audits the switch', async () => {
    const target: AreaRow = {
      id: AREA_ID,
      familyId: FAMILY_ID,
      city: 'Ottawa',
      province: 'ON',
      note: "grandma's",
      postalCode: 'K1P 1J1',
      isActive: false,
      createdAt: new Date(),
    };
    const { db, capture } = fakeDb({ limitRows: [target] });
    const result = await setActiveArea(db, {
      familyId: FAMILY_ID,
      userId: USER_ID,
      areaId: AREA_ID,
    });

    expect(result).toEqual({ status: 'activated' });
    // Exactly two updates: clear-all-active, then set-this-active — the exclusivity swap.
    expect(capture.updates).toHaveLength(2);
    expect(capture.updates[0]?.payload).toEqual({ isActive: false });
    expect(capture.updates[1]?.payload).toEqual({ isActive: true });
    const audit = capture.inserts.find((i) => i.table === schema.auditLog);
    expect(audit?.rows[0]).toEqual(
      expect.objectContaining({
        familyId: FAMILY_ID,
        actor: USER_ID,
        actionTaken: 'village_area_activated',
        targetTable: 'family_areas',
        targetId: AREA_ID,
      }),
    );
  });

  it("cross-family isolation: another family's areaId is NOT found — no update, no audit", async () => {
    // The by-(id, familyId) lookup returns nothing → the area is not this family's.
    const { db, capture } = fakeDb({ limitRows: [] });
    const result = await setActiveArea(db, {
      familyId: OTHER_FAMILY_ID,
      userId: USER_ID,
      areaId: AREA_ID,
    });
    expect(result).toEqual({ status: 'not_found' });
    expect(capture.updates).toEqual([]);
    expect(capture.inserts).toEqual([]);
  });
});

describe('resolveActiveAreaCoarse — active area drives village content, legacy fallback', () => {
  it('derives the coarse area from the ACTIVE row (postal prefix), overriding the legacy field', async () => {
    const active: AreaRow = {
      id: AREA_ID,
      familyId: FAMILY_ID,
      city: 'Ottawa',
      province: 'ON',
      note: null,
      postalCode: 'K1P 1J1',
      isActive: true,
      createdAt: new Date(),
    };
    // Legacy field is a DIFFERENT area — the active row must win.
    const { db } = fakeDb({ limitRows: [active], family: { areaCoarse: 'L7G' } });
    const coarse = await resolveActiveAreaCoarse(db, FAMILY_ID);
    expect(coarse).toBe('K1P');
  });

  it('falls back to the legacy families.area_coarse when the family has NO active row (backfill-equivalent)', async () => {
    const { db } = fakeDb({ limitRows: [], family: { areaCoarse: 'L7G' } });
    const coarse = await resolveActiveAreaCoarse(db, FAMILY_ID);
    expect(coarse).toBe('L7G');
  });

  it('returns null when there is neither an active row nor a legacy area', async () => {
    const { db } = fakeDb({ limitRows: [], family: { areaCoarse: null } });
    expect(await resolveActiveAreaCoarse(db, FAMILY_ID)).toBeNull();
  });
});

describe('readActiveArea — the header label', () => {
  it('returns the ACTIVE row city/province', async () => {
    const active: AreaRow = {
      id: AREA_ID,
      familyId: FAMILY_ID,
      city: 'Ottawa',
      province: 'ON',
      note: null,
      postalCode: 'K1P 1J1',
      isActive: true,
      createdAt: new Date(),
    };
    const { db } = fakeDb({ limitRows: [active], family: { city: 'Burlington', province: 'ON' } });
    expect(await readActiveArea(db, FAMILY_ID)).toEqual({ city: 'Ottawa', province: 'ON' });
  });

  it('falls back to the legacy family city/province, null when no city', async () => {
    const { db } = fakeDb({ limitRows: [], family: { city: 'Burlington', province: 'ON' } });
    expect(await readActiveArea(db, FAMILY_ID)).toEqual({ city: 'Burlington', province: 'ON' });

    const { db: db2 } = fakeDb({ limitRows: [], family: { city: null } });
    expect(await readActiveArea(db2, FAMILY_ID)).toBeNull();
  });
});

describe('listAreas — the switcher list', () => {
  it('maps rows to the coarse SavedArea view (ISO createdAt), preserving isActive', async () => {
    const rows: AreaRow[] = [
      {
        id: AREA_ID,
        familyId: FAMILY_ID,
        city: 'Burlington',
        province: 'ON',
        note: 'home',
        postalCode: 'L7G 0A1',
        isActive: true,
        createdAt: new Date('2026-07-01T00:00:00Z'),
      },
    ];
    const { db } = fakeDb({ areaRows: rows });
    const areas = await listAreas(db, FAMILY_ID);
    expect(areas).toEqual([
      {
        id: AREA_ID,
        city: 'Burlington',
        province: 'ON',
        note: 'home',
        postalCode: 'L7G 0A1',
        isActive: true,
        createdAt: '2026-07-01T00:00:00.000Z',
      },
    ]);
  });
});
