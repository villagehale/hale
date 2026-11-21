import { schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import {
  BRING_PENDING_MAX_AGE_MS,
  attachPendingBringItems,
  bringItemsAlreadyRead,
  bringSourceRef,
  loadBringItemsFor,
  recordBringItems,
} from './store';

/**
 * VIL-720 · the bring-list store on a real Postgres (PGlite + the committed migrations,
 * 0259 included). Every id, title and item is invented.
 */

let db: TestDb;
let familyId: string;
let parentUserId: string;
let coParentUserId: string;
let eventId: string;

const NOW = new Date('2026-11-20T15:00:00Z');
const INTEGRATION = '11111111-1111-4000-8000-000000000720';

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

async function seedCoParent(id: string): Promise<string> {
  const [user] = await db.database
    .insert(schema.users)
    .values({ email: `coparent-${id}@example.test`, name: 'Co Parent' })
    .returning({ id: schema.users.id });
  if (!user) throw new Error('no co-parent');
  await db.database
    .insert(schema.familyMembers)
    .values({ familyId: id, userId: user.id, role: 'co_parent' });
  return user.id;
}

async function seedEvent(title = 'Swim lessons'): Promise<string> {
  const [event] = await db.database
    .insert(schema.familyEvents)
    .values({
      familyId,
      title,
      startsAt: new Date('2026-11-21T14:30:00Z'),
      source: 'placement',
    })
    .returning({ id: schema.familyEvents.id });
  if (!event) throw new Error('no event');
  return event.id;
}

beforeEach(async () => {
  ({ familyId, parentUserId } = await seedFamily(db.database));
  coParentUserId = await seedCoParent(familyId);
  eventId = await seedEvent();
});

function rows() {
  return db.database
    .select()
    .from(schema.familyEventBringItems)
    .where(eq(schema.familyEventBringItems.familyId, familyId));
}

function audits(action: string) {
  return db.database
    .select()
    .from(schema.auditLog)
    .where(and(eq(schema.auditLog.familyId, familyId), eq(schema.auditLog.actionTaken, action)));
}

describe('recordBringItems', () => {
  it('keeps a list against an event for its owner, with an audit row that holds counts only', async () => {
    const sourceRef = bringSourceRef(INTEGRATION, 'gmail-msg-1');
    expect(
      await recordBringItems(db.database, {
        familyId,
        ownerUserId: parentUserId,
        eventId,
        sourceKind: 'email',
        sourceRef,
        items: ['a swimsuit', 'towel'],
        now: NOW,
      }),
    ).toBe('recorded');
    const [row] = await rows();
    expect(row).toMatchObject({
      ownerUserId: parentUserId,
      eventId,
      sourceKind: 'email',
      sourceRef: `${INTEGRATION}:gmail-msg-1`,
      items: ['a swimsuit', 'towel'],
    });
    expect(row?.attachedAt?.toISOString()).toBe(NOW.toISOString());
    const [audit] = await audits('bring_items_recorded');
    expect(audit).toMatchObject({
      actor: 'system',
      audience: parentUserId,
      targetTable: 'family_event_bring_items',
      targetId: row?.id,
      after: { source: 'email', count: 2, onEvent: true },
    });
    expect(JSON.stringify(audit)).not.toContain('swimsuit');
    expect(await bringItemsAlreadyRead(db.database, { ownerUserId: parentUserId, sourceRef })).toBe(
      true,
    );
    expect(
      await bringItemsAlreadyRead(db.database, { ownerUserId: coParentUserId, sourceRef }),
    ).toBe(false);
  });

  it('one list per source per parent: a second write changes nothing', async () => {
    const input = {
      familyId,
      ownerUserId: parentUserId,
      eventId,
      sourceKind: 'email' as const,
      sourceRef: bringSourceRef(INTEGRATION, 'gmail-msg-2'),
      items: ['skates'],
      now: NOW,
    };
    expect(await recordBringItems(db.database, input)).toBe('recorded');
    expect(await recordBringItems(db.database, { ...input, items: ['helmet'] })).toBe(
      'already_recorded',
    );
    expect((await rows()).map((row) => row.items)).toEqual([['skates']]);
    expect(await audits('bring_items_recorded')).toHaveLength(1);
  });

  it('an empty list keeps nothing', async () => {
    expect(
      await recordBringItems(db.database, {
        familyId,
        ownerUserId: parentUserId,
        eventId,
        sourceKind: 'photo',
        sourceRef: bringSourceRef(INTEGRATION, 'coach:empty'),
        items: [],
        now: NOW,
      }),
    ).toBe('empty');
    expect(await rows()).toEqual([]);
  });

  it("deletes this parent's pending lists too old to be attached; keeps fresh and attached ones", async () => {
    const old = new Date(NOW.getTime() - BRING_PENDING_MAX_AGE_MS - 60_000);
    await recordBringItems(db.database, {
      familyId,
      ownerUserId: parentUserId,
      eventId: null,
      sourceKind: 'email',
      sourceRef: bringSourceRef(INTEGRATION, 'stale-pending'),
      items: ['old item'],
      now: old,
    });
    await recordBringItems(db.database, {
      familyId,
      ownerUserId: parentUserId,
      eventId,
      sourceKind: 'email',
      sourceRef: bringSourceRef(INTEGRATION, 'old-attached'),
      items: ['kept'],
      now: old,
    });
    await recordBringItems(db.database, {
      familyId,
      ownerUserId: coParentUserId,
      eventId: null,
      sourceKind: 'email',
      sourceRef: bringSourceRef(INTEGRATION, 'coparent-stale'),
      items: ['not mine to delete'],
      now: old,
    });
    await recordBringItems(db.database, {
      familyId,
      ownerUserId: parentUserId,
      eventId: null,
      sourceKind: 'email',
      sourceRef: bringSourceRef(INTEGRATION, 'fresh-pending'),
      items: ['fresh'],
      now: NOW,
    });
    expect((await rows()).map((row) => row.sourceRef).sort()).toEqual(
      [
        bringSourceRef(INTEGRATION, 'coparent-stale'),
        bringSourceRef(INTEGRATION, 'fresh-pending'),
        bringSourceRef(INTEGRATION, 'old-attached'),
      ].sort(),
    );
  });
});

describe('attachPendingBringItems — the parent said yes', () => {
  it('attaches the pending list from the same source once, for its owner only', async () => {
    const sourceRef = bringSourceRef(INTEGRATION, 'offer-msg');
    await recordBringItems(db.database, {
      familyId,
      ownerUserId: parentUserId,
      eventId: null,
      sourceKind: 'email',
      sourceRef,
      items: ['a packed lunch', 'a signed permission slip'],
      now: NOW,
    });
    // The co-parent answering cannot attach a list from another parent's mail.
    expect(
      await attachPendingBringItems(db.database, {
        familyId,
        ownerUserId: coParentUserId,
        sourceRef,
        eventId,
        now: NOW,
      }),
    ).toBe(0);
    const later = new Date(NOW.getTime() + 60_000);
    expect(
      await attachPendingBringItems(db.database, {
        familyId,
        ownerUserId: parentUserId,
        sourceRef,
        eventId,
        now: later,
      }),
    ).toBe(1);
    expect(
      await attachPendingBringItems(db.database, {
        familyId,
        ownerUserId: parentUserId,
        sourceRef,
        eventId,
        now: later,
      }),
    ).toBe(0);
    const [row] = await rows();
    expect(row?.eventId).toBe(eventId);
    expect(row?.attachedAt?.toISOString()).toBe(later.toISOString());
    const attached = await audits('bring_items_attached');
    expect(attached).toHaveLength(1);
    expect(attached[0]).toMatchObject({
      actor: parentUserId,
      audience: parentUserId,
      after: { source: 'email', count: 2 },
    });
  });
});

describe('loadBringItemsFor — what one parent may hear', () => {
  it("returns the owner's attached lists only, merged per event, repeats dropped", async () => {
    const second = await seedEvent('Skating');
    await recordBringItems(db.database, {
      familyId,
      ownerUserId: parentUserId,
      eventId,
      sourceKind: 'email',
      sourceRef: bringSourceRef(INTEGRATION, 'a'),
      items: ['a swimsuit', 'towel'],
      now: NOW,
    });
    await recordBringItems(db.database, {
      familyId,
      ownerUserId: parentUserId,
      eventId,
      sourceKind: 'photo',
      sourceRef: bringSourceRef(INTEGRATION, 'coach:b'),
      items: ['Towel', 'goggles'],
      now: new Date(NOW.getTime() + 1000),
    });
    await recordBringItems(db.database, {
      familyId,
      ownerUserId: coParentUserId,
      eventId: second,
      sourceKind: 'email',
      sourceRef: bringSourceRef(INTEGRATION, 'c'),
      items: ['skates'],
      now: NOW,
    });
    await recordBringItems(db.database, {
      familyId,
      ownerUserId: parentUserId,
      eventId: null,
      sourceKind: 'email',
      sourceRef: bringSourceRef(INTEGRATION, 'pending'),
      items: ['pending item'],
      now: NOW,
    });

    const mine = await loadBringItemsFor(db.database, {
      familyId,
      ownerUserId: parentUserId,
      eventIds: [eventId, second],
    });
    expect(Object.fromEntries(mine)).toEqual({ [eventId]: ['a swimsuit', 'towel', 'goggles'] });

    const theirs = await loadBringItemsFor(db.database, {
      familyId,
      ownerUserId: coParentUserId,
      eventIds: [eventId, second],
    });
    expect(Object.fromEntries(theirs)).toEqual({ [second]: ['skates'] });

    expect(
      (
        await loadBringItemsFor(db.database, {
          familyId,
          ownerUserId: parentUserId,
          eventIds: [],
        })
      ).size,
    ).toBe(0);
  });

  it('never crosses families', async () => {
    await recordBringItems(db.database, {
      familyId,
      ownerUserId: parentUserId,
      eventId,
      sourceKind: 'email',
      sourceRef: bringSourceRef(INTEGRATION, 'x'),
      items: ['towel'],
      now: NOW,
    });
    const other = await seedFamily(db.database, 'Other Family');
    expect(
      (
        await loadBringItemsFor(db.database, {
          familyId: other.familyId,
          ownerUserId: parentUserId,
          eventIds: [eventId],
        })
      ).size,
    ).toBe(0);
  });
});
