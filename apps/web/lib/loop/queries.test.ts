import { schema } from '@hale/db';
import { describe, expect, it, vi } from 'vitest';
import {
  createFamilyEvent,
  hasWeekPlan,
  listFamilyEventsInWindow,
  readWeekPlan,
  upsertWeekPlan,
} from './queries.js';

/**
 * The drizzle operators are replaced with inspectable MARKERS (the real module is
 * otherwise preserved) so the fake db can genuinely evaluate a query's where/order
 * against a seeded in-memory store — that is what makes the family-scope isolation
 * test real: drop the family_id filter and another family's rows leak through.
 */
vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  return {
    ...actual,
    eq: (col: unknown, val: unknown) => ({ marker: 'eq', col, val }),
    ne: (col: unknown, val: unknown) => ({ marker: 'ne', col, val }),
    and: (...conds: unknown[]) => ({ marker: 'and', conds }),
    gte: (col: unknown, val: unknown) => ({ marker: 'gte', col, val }),
    lte: (col: unknown, val: unknown) => ({ marker: 'lte', col, val }),
    isNull: (col: unknown) => ({ marker: 'isNull', col }),
    asc: (col: unknown) => ({ marker: 'asc', col }),
  };
});

const FAMILY_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_FAMILY_ID = '22222222-2222-4222-8222-222222222222';
const CHILD_ID = '33333333-3333-4333-8333-333333333333';
const USER_ID = '55555555-5555-4555-8555-555555555555';
const PLAN_ID = '66666666-6666-4666-8666-666666666666';
const EVENT_ID = '77777777-7777-4777-8777-777777777777';
const WEEK_START = '2026-07-20';

type Marker =
  | { marker: 'and'; conds: Marker[] }
  | { marker: 'eq' | 'ne' | 'gte' | 'lte'; col: unknown; val: unknown }
  | { marker: 'isNull'; col: unknown }
  | { marker: 'asc'; col: unknown };

interface FamilyEventRow {
  id: string;
  familyId: string;
  childId: string | null;
  title: string;
  startsAt: Date;
  endsAt: Date | null;
  location: string | null;
  source: 'parent' | 'channel' | 'email' | 'placement';
  createdBy: string | null;
  createdAt: Date;
  deletedAt: Date | null;
}

interface Capture {
  inserts: Array<{ table: unknown; rows: Record<string, unknown>[] }>;
  conflicts: Array<{ table: unknown; target: unknown; set: Record<string, unknown> }>;
}

/** Resolves a family_events column marker to its row key, throwing on any column
 * the composer's query shouldn't touch — so a wrong-column filter fails loudly. */
function eventKey(col: unknown): 'familyId' | 'startsAt' | 'source' | 'deletedAt' {
  if (col === schema.familyEvents.familyId) return 'familyId';
  if (col === schema.familyEvents.startsAt) return 'startsAt';
  if (col === schema.familyEvents.source) return 'source';
  if (col === schema.familyEvents.deletedAt) return 'deletedAt';
  throw new Error('fakeDb: family_events query referenced an unexpected column');
}

function matches(cond: Marker | undefined, row: FamilyEventRow): boolean {
  if (!cond) throw new Error('fakeDb: family_events query ran with no where clause');
  switch (cond.marker) {
    case 'and':
      return cond.conds.every((c) => matches(c, row));
    case 'eq':
      return row[eventKey(cond.col)] === cond.val;
    case 'ne':
      return row[eventKey(cond.col)] !== cond.val;
    case 'isNull':
      return row[eventKey(cond.col)] === null;
    case 'gte':
      return (row[eventKey(cond.col)] as Date).getTime() >= (cond.val as Date).getTime();
    case 'lte':
      return (row[eventKey(cond.col)] as Date).getTime() <= (cond.val as Date).getTime();
    default:
      throw new Error('fakeDb: unexpected operator');
  }
}

function sortByOrder(rows: FamilyEventRow[], order: Marker): FamilyEventRow[] {
  const key = eventKey((order as { col: unknown }).col);
  return [...rows].sort((a, b) => (a[key] as Date).getTime() - (b[key] as Date).getTime());
}

/**
 * A table-routed fake db covering the exact chains queries.ts runs, with NO real db:
 *   - select(...).from(weekPlans).where().limit(1)            → `weekPlanRows`
 *   - select().from(familyEvents).where(cond).orderBy(order)  → `eventRows`, genuinely
 *                                                               filtered by cond + sorted
 *   - insert(t).values(rows).onConflictDoUpdate({target,set}) → captured (week_plans upsert)
 *   - insert(familyEvents).values(rows).returning({id})       → captured; returns insertedEventId
 */
function fakeDb(store: {
  weekPlanRows?: Record<string, unknown>[];
  eventRows?: FamilyEventRow[];
  insertedEventId?: string;
}) {
  const capture: Capture = { inserts: [], conflicts: [] };

  const select = (_cols?: unknown) => {
    let tbl: unknown;
    let cond: Marker | undefined;
    const builder = {
      from(t: unknown) {
        tbl = t;
        return builder;
      },
      where(c: Marker) {
        cond = c;
        return builder;
      },
      limit() {
        return Promise.resolve(tbl === schema.weekPlans ? (store.weekPlanRows ?? []) : []);
      },
      orderBy(order: Marker) {
        const rows = (store.eventRows ?? []).filter((r) => matches(cond, r));
        return Promise.resolve(sortByOrder(rows, order));
      },
    };
    return builder;
  };

  const insert = (table: unknown) => ({
    values(rowsArg: unknown) {
      const rows = (Array.isArray(rowsArg) ? rowsArg : [rowsArg]) as Record<string, unknown>[];
      capture.inserts.push({ table, rows });
      const p = Promise.resolve(undefined) as Promise<undefined> & {
        returning: () => Promise<Array<Record<string, unknown>>>;
        onConflictDoUpdate: (cfg: {
          target: unknown;
          set: Record<string, unknown>;
        }) => Promise<undefined>;
      };
      p.returning = () =>
        Promise.resolve(
          table === schema.familyEvents && store.insertedEventId
            ? [{ id: store.insertedEventId }]
            : [],
        );
      p.onConflictDoUpdate = (cfg) => {
        capture.conflicts.push({ table, target: cfg.target, set: cfg.set });
        return Promise.resolve(undefined);
      };
      return p;
    },
  });

  return { db: { select, insert } as never, capture };
}

function makeEvent(
  over: Partial<FamilyEventRow> & { id: string; familyId: string; startsAt: Date },
): FamilyEventRow {
  return {
    childId: null,
    title: 'Occasion',
    endsAt: null,
    location: null,
    source: 'parent',
    createdBy: null,
    createdAt: new Date('2026-07-01T00:00:00Z'),
    deletedAt: null,
    ...over,
  };
}

describe('upsertWeekPlan — one idempotent plan per (family, week)', () => {
  it('inserts the family-scoped plan (status default composed) and targets the (family, week) conflict', async () => {
    const items: schema.WeekPlanItem[] = [
      {
        kind: 'appointment',
        title: 'Checkup',
        childIds: [CHILD_ID],
        startsAt: WEEK_START,
        endsAt: null,
        location: null,
        sourceRef: null,
        needs: 'calendar_add',
        privacySensitive: true,
      },
    ];
    const { db, capture } = fakeDb({});
    await upsertWeekPlan(db, {
      familyId: FAMILY_ID,
      weekStart: WEEK_START,
      summary: 'A calm week.',
      items,
    });

    const insert = capture.inserts.find((i) => i.table === schema.weekPlans);
    expect(insert).toBeDefined();
    const row = insert?.rows[0] as Record<string, unknown>;
    expect(row.familyId).toBe(FAMILY_ID);
    expect(row.weekStart).toBe(WEEK_START);
    expect(row.summary).toBe('A calm week.');
    // The typed jsonb item array is stored verbatim.
    expect(row.items).toBe(items);
    expect(row.status).toBe('composed');
    expect(row.composedAt).toBeInstanceOf(Date);

    const conflict = capture.conflicts.find((c) => c.table === schema.weekPlans);
    expect(conflict).toBeDefined();
    // Idempotent per (family_id, week_start): the unique pair IS the conflict target.
    const target = conflict?.target as unknown[];
    expect(target).toHaveLength(2);
    expect(target[0]).toBe(schema.weekPlans.familyId);
    expect(target[1]).toBe(schema.weekPlans.weekStart);
    // A recompose overwrites summary/items/status/composedAt.
    expect(conflict?.set.summary).toBe('A calm week.');
    expect(conflict?.set.items).toBe(items);
    expect(conflict?.set.status).toBe('composed');
    expect(conflict?.set.composedAt).toBeInstanceOf(Date);
  });
});

describe('hasWeekPlan — the idempotent-spend pre-check', () => {
  it('is true when the week already has a plan, false when it has none', async () => {
    const present = fakeDb({ weekPlanRows: [{ id: PLAN_ID }] });
    expect(await hasWeekPlan(present.db, FAMILY_ID, WEEK_START)).toBe(true);

    const absent = fakeDb({ weekPlanRows: [] });
    expect(await hasWeekPlan(absent.db, FAMILY_ID, WEEK_START)).toBe(false);
  });
});

describe('readWeekPlan', () => {
  it('returns the plan row, or null when the week has none', async () => {
    const planRow = {
      id: PLAN_ID,
      familyId: FAMILY_ID,
      weekStart: WEEK_START,
      composedAt: new Date('2026-07-19T00:00:00Z'),
      summary: 'A calm week.',
      items: [],
      status: 'composed',
    };
    const found = fakeDb({ weekPlanRows: [planRow] });
    expect(await readWeekPlan(found.db, FAMILY_ID, WEEK_START)).toEqual(planRow);

    const none = fakeDb({ weekPlanRows: [] });
    expect(await readWeekPlan(none.db, FAMILY_ID, WEEK_START)).toBeNull();
  });
});

describe('createFamilyEvent', () => {
  it('inserts the family-scoped event and returns the new row id', async () => {
    const { db, capture } = fakeDb({ insertedEventId: EVENT_ID });
    const startsAt = new Date('2026-07-22T18:00:00Z');
    const id = await createFamilyEvent(db, {
      familyId: FAMILY_ID,
      childId: CHILD_ID,
      title: "Leo's party",
      startsAt,
      endsAt: null,
      location: 'the park',
      source: 'channel',
      createdBy: USER_ID,
    });

    expect(id).toBe(EVENT_ID);
    const insert = capture.inserts.find((i) => i.table === schema.familyEvents);
    const row = insert?.rows[0] as Record<string, unknown>;
    expect(row.familyId).toBe(FAMILY_ID);
    expect(row.childId).toBe(CHILD_ID);
    expect(row.title).toBe("Leo's party");
    expect(row.startsAt).toBe(startsAt);
    expect(row.endsAt).toBeNull();
    expect(row.location).toBe('the park');
    expect(row.source).toBe('channel');
    expect(row.createdBy).toBe(USER_ID);
  });
});

describe('listFamilyEventsInWindow — family-scoped, in-window, ordered (rule #1)', () => {
  it("returns only THIS family's in-window events, oldest-first, excluding another family's and out-of-window rows", async () => {
    const windowStart = new Date('2026-07-20T00:00:00Z');
    const windowEnd = new Date('2026-07-27T00:00:00Z');

    const inWindowLater = makeEvent({
      id: 'ev-later',
      familyId: FAMILY_ID,
      startsAt: new Date('2026-07-24T18:00:00Z'),
    });
    const inWindowEarlier = makeEvent({
      id: 'ev-earlier',
      familyId: FAMILY_ID,
      startsAt: new Date('2026-07-21T09:00:00Z'),
    });
    // Same window, DIFFERENT family — must never appear (family-scope isolation).
    const otherFamilyInWindow = makeEvent({
      id: 'ev-other',
      familyId: OTHER_FAMILY_ID,
      startsAt: new Date('2026-07-22T12:00:00Z'),
    });
    // This family, but before / after the window — excluded by the starts_at range.
    const ownBeforeWindow = makeEvent({
      id: 'ev-before',
      familyId: FAMILY_ID,
      startsAt: new Date('2026-07-19T23:00:00Z'),
    });
    const ownAfterWindow = makeEvent({
      id: 'ev-after',
      familyId: FAMILY_ID,
      startsAt: new Date('2026-07-28T00:00:00Z'),
    });

    const { db } = fakeDb({
      eventRows: [
        inWindowLater,
        otherFamilyInWindow,
        ownBeforeWindow,
        inWindowEarlier,
        ownAfterWindow,
      ],
    });
    const rows = await listFamilyEventsInWindow(db, FAMILY_ID, windowStart, windowEnd);
    expect(rows.map((r) => r.id)).toEqual(['ev-earlier', 'ev-later']);
  });

  it('excludes placements (durable, already placed) and soft-deleted rows (VIL-219)', async () => {
    const windowStart = new Date('2026-07-20T00:00:00Z');
    const windowEnd = new Date('2026-07-27T00:00:00Z');

    const occasion = makeEvent({
      id: 'ev-occasion',
      familyId: FAMILY_ID,
      startsAt: new Date('2026-07-22T09:00:00Z'),
    });
    // A placement Hale already added — surfacing it would loop it back into the plan.
    const placement = makeEvent({
      id: 'ev-placement',
      familyId: FAMILY_ID,
      startsAt: new Date('2026-07-23T09:00:00Z'),
      source: 'placement',
    });
    // A cancelled/soft-deleted occasion — never surfaced.
    const softDeleted = makeEvent({
      id: 'ev-deleted',
      familyId: FAMILY_ID,
      startsAt: new Date('2026-07-24T09:00:00Z'),
      deletedAt: new Date('2026-07-21T00:00:00Z'),
    });

    const { db } = fakeDb({ eventRows: [occasion, placement, softDeleted] });
    const rows = await listFamilyEventsInWindow(db, FAMILY_ID, windowStart, windowEnd);
    expect(rows.map((r) => r.id)).toEqual(['ev-occasion']);
  });
});
