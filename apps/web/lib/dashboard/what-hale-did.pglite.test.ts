import { schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  type SeededFamily,
  type TestDb,
  createTestDb,
  seedChild,
  seedFamily,
} from '~/lib/testing/pglite';
import { TEEN_REDACTED_PLACEHOLDER } from './mappers';
import {
  FamilyWithoutMembersError,
  type WhatHaleDidItem,
  readFamilyOwnTimezone,
  readWhatHaleDid,
} from './what-hale-did';

/**
 * "What Hale did" over the real DDL: only executed email and calendar actions, newest
 * first, in the family's own zone (Vancouver here, never the Eastern render default),
 * with a 13+ child's rows redacted. Every events row states its attribution, because a
 * teen family redacts an unattributed child_content row by default.
 *
 * The clock is pinned after pglite boots: the formatter prints the year once an
 * instant's year differs from now, so the exact strings below would break on
 * 2027-01-01 with a real clock.
 */

const PINNED_NOW = new Date('2026-07-01T12:00:00Z');
const PRIMARY_ZONE = 'America/Vancouver';

let db: TestDb;
let fam: SeededFamily;
const ids: Record<string, string> = {};

type ActionInsert = Omit<typeof schema.actions.$inferInsert, 'eventId' | 'familyId'>;
type EventAttribution = Pick<typeof schema.events.$inferInsert, 'childId' | 'contentProvenance'>;

async function mint(key: string, event: EventAttribution, action: ActionInsert) {
  const [ev] = await db.database
    .insert(schema.events)
    .values({
      familyId: fam.familyId,
      source: 'test',
      eventType: 'signal.test',
      dedupHash: `what-hale-did-${key}`,
      status: 'actioned',
      ...event,
    })
    .returning({ id: schema.events.id });
  if (!ev) throw new Error(`fixture: no event for ${key}`);
  const [row] = await db.database
    .insert(schema.actions)
    .values({ ...action, eventId: ev.id, familyId: fam.familyId })
    .returning({ id: schema.actions.id });
  if (!row) throw new Error(`fixture: no action for ${key}`);
  ids[key] = row.id;
}

const at = (iso: string) => new Date(iso);
const approved = { reviewerVerdict: 'approved' } as const;

beforeAll(async () => {
  db = await createTestDb();
  vi.useFakeTimers({ now: PINNED_NOW, toFake: ['Date'] });
  fam = await seedFamily(db.database, 'Fixture Family');
  await db.database
    .update(schema.users)
    .set({ timezone: PRIMARY_ZONE })
    .where(eq(schema.users.id, fam.parentUserId));
  const young = await seedChild(db.database, fam.familyId, 'Wren', 48, undefined, PINNED_NOW);
  const teen = await seedChild(db.database, fam.familyId, 'Rowan', 168, undefined, PINNED_NOW);

  await mint(
    'a',
    { childId: young },
    {
      ...approved,
      actionType: 'send_email',
      payload: { to: 'coach@example.test', subject: 'Practice moved' },
      draftedAt: at('2026-06-19T15:00:00Z'),
      userVisibleState: 'autonomous',
      executedAt: at('2026-06-19T15:30:00Z'),
      executorResult: { kind: 'email_sent' },
    },
  );
  await mint(
    'b',
    { childId: null, contentProvenance: 'hale_authored' },
    {
      ...approved,
      actionType: 'calendar_add',
      payload: { title: 'Swim lesson', startsAt: '2026-06-21T17:00:00Z' },
      draftedAt: at('2026-06-20T15:30:00Z'),
      userVisibleState: 'autonomous',
      executedAt: at('2026-06-20T16:00:00Z'),
      executorResult: { kind: 'calendar_placed', google: { status: 'written' } },
    },
  );
  await mint(
    'c',
    { childId: teen },
    {
      ...approved,
      actionType: 'calendar_add',
      payload: { title: 'SECRET-TEEN-TITLE', startsAt: '2026-06-22T17:00:00Z' },
      draftedAt: at('2026-06-18T11:30:00Z'),
      userVisibleState: 'autonomous',
      executedAt: at('2026-06-18T12:00:00Z'),
      executorResult: { kind: 'calendar_placed', google: { status: 'skipped' } },
    },
  );
  await mint(
    'c2',
    { childId: null },
    {
      ...approved,
      actionType: 'send_email',
      payload: { to: 'office@example.test', subject: 'FAMILY-WIDE-SUBJECT' },
      draftedAt: at('2026-06-17T11:30:00Z'),
      userVisibleState: 'autonomous',
      executedAt: at('2026-06-17T12:00:00Z'),
    },
  );
  const hale = { childId: null, contentProvenance: 'hale_authored' } as const;
  await mint('d', hale, {
    ...approved,
    actionType: 'send_email',
    payload: { to: 'drafted@example.test', subject: 'Waiting on you' },
    draftedAt: at('2026-06-25T12:00:00Z'),
    userVisibleState: 'drafted_for_approval',
  });
  await mint('e', hale, {
    ...approved,
    actionType: 'calendar_add',
    payload: { title: 'Declined placement', startsAt: '2026-06-26T17:00:00Z' },
    draftedAt: at('2026-06-25T12:00:00Z'),
    userVisibleState: 'reverted',
    revertedAt: at('2026-06-25T13:00:00Z'),
    revertedReason: 'declined_by_human',
  });
  await mint('f', hale, {
    ...approved,
    actionType: 'send_email',
    payload: { to: 'failed@example.test', subject: 'Did not send' },
    draftedAt: at('2026-06-24T12:00:00Z'),
    userVisibleState: 'needs_human',
    executedAt: at('2026-06-24T12:05:00Z'),
  });
  await mint('g', hale, {
    ...approved,
    actionType: 'send_email',
    payload: { to: 'held@example.test', subject: 'Held for you' },
    draftedAt: at('2026-06-23T12:00:00Z'),
    userVisibleState: 'needs_human',
  });
  await mint('h', hale, {
    ...approved,
    actionType: 'add_to_routine',
    payload: { title: 'Bedtime' },
    draftedAt: at('2026-06-22T12:00:00Z'),
    userVisibleState: 'autonomous',
    executedAt: at('2026-06-22T12:05:00Z'),
  });
  await db.database.insert(schema.auditLog).values({
    familyId: fam.familyId,
    actor: 'system',
    actionTaken: 'event.classified',
    targetTable: 'events',
    occurredAt: at('2026-06-27T12:00:00Z'),
  });
});

afterAll(async () => {
  vi.useRealTimers();
  await db.close();
});

function byId(items: WhatHaleDidItem[], key: string): WhatHaleDidItem {
  const item = items.find((i) => i.id === ids[key]);
  if (!item) throw new Error(`no item for ${key}`);
  return item;
}

describe('readWhatHaleDid', () => {
  it('lists only executed emails and calendar changes, newest first', async () => {
    const items = await readWhatHaleDid(db.database, fam.familyId, fam.parentUserId);
    expect(items.map((i) => i.id)).toEqual([ids.b, ids.a, ids.c, ids.c2]);
  });

  it('says what Hale did, to whom, in the family’s own zone', async () => {
    const items = await readWhatHaleDid(db.database, fam.familyId, fam.parentUserId);
    const a = byId(items, 'a');
    const b = byId(items, 'b');

    expect(a.what).toBe('Email coach@example.test — Practice moved');
    expect(a.kind).toBe('email');
    expect(a.calendars).toEqual([]);
    // June is PDT (UTC−7): 15:30Z is 08:30 in Vancouver, 11:30 in the Eastern default.
    expect(a.when).toContain('Jun 19');
    expect(a.when).toContain('08:30');
    expect(a.when).not.toContain('11:30');
    expect(a.when).not.toContain('15:30');

    expect(b.what).toBe('Add to your calendar — Swim lesson, Jun 21, 10:00');
    expect(b.calendars).toEqual(['hale_calendar', 'google_calendar']);
  });

  it('redacts a 13+ child’s row and an unattributed family-wide row, and only those', async () => {
    const items = await readWhatHaleDid(db.database, fam.familyId, fam.parentUserId);
    const c = byId(items, 'c');
    const c2 = byId(items, 'c2');

    expect(c.what).toBe(TEEN_REDACTED_PLACEHOLDER);
    expect(c.teenRedacted).toBe(true);
    expect(c2.what).toBe(TEEN_REDACTED_PLACEHOLDER);
    expect(c2.teenRedacted).toBe(true);
    expect(byId(items, 'a').teenRedacted).toBe(false);
    expect(byId(items, 'b').teenRedacted).toBe(false);

    const json = JSON.stringify(items);
    expect(json).not.toContain('SECRET-TEEN-TITLE');
    expect(json).not.toContain('FAMILY-WIDE-SUBJECT');
    expect(json).toContain('Swim lesson');
    expect(json).toContain('Practice moved');
  });

  it('never carries an audit step or a routine pin', async () => {
    const items = await readWhatHaleDid(db.database, fam.familyId, fam.parentUserId);
    for (const item of items) {
      expect(item.what).not.toContain('understood a new signal');
      expect(item.what).not.toContain('Pin to your routine');
      expect(item.what).not.toContain('Bedtime');
    }
    expect(items.map((i) => i.id)).toContain(ids.a);
    expect(items.map((i) => i.id)).toContain(ids.b);
  });
});

describe('the family zone', () => {
  it('takes the primary parent’s zone over an earlier-joined co-parent’s', async () => {
    const [coParent] = await db.database
      .insert(schema.users)
      .values({ email: 'co-parent@example.test', name: 'Co Parent', timezone: 'America/Edmonton' })
      .returning({ id: schema.users.id });
    if (!coParent) throw new Error('fixture: no co-parent');
    await db.database.insert(schema.familyMembers).values({
      familyId: fam.familyId,
      userId: coParent.id,
      role: 'co_parent',
      joinedAt: at('2020-01-01T00:00:00Z'),
    });

    const items = await readWhatHaleDid(db.database, fam.familyId, fam.parentUserId);
    expect(byId(items, 'a').when).toContain('08:30');
  });

  it('falls back to the earliest-joined member’s zone, never a constant', async () => {
    await db.database
      .delete(schema.familyMembers)
      .where(
        and(
          eq(schema.familyMembers.familyId, fam.familyId),
          eq(schema.familyMembers.userId, fam.parentUserId),
        ),
      );

    const items = await readWhatHaleDid(db.database, fam.familyId, fam.parentUserId);
    const when = byId(items, 'a').when;
    // June is MDT (UTC−6): 15:30Z is 09:30 in Edmonton.
    expect(when).toContain('09:30');
    expect(when).not.toContain('11:30');
    expect(when).not.toContain('08:30');
  });

  // Inserted AFTER the Edmonton co-parent but joined earlier, so a reader that took
  // insertion order, or the latest join, would still answer Edmonton.
  it('breaks the tie between non-primary members by the earliest join', async () => {
    const [grandparent] = await db.database
      .insert(schema.users)
      .values({
        email: 'grandparent@example.test',
        name: 'Grand Parent',
        timezone: 'America/Halifax',
      })
      .returning({ id: schema.users.id });
    if (!grandparent) throw new Error('fixture: no grandparent');
    await db.database.insert(schema.familyMembers).values({
      familyId: fam.familyId,
      userId: grandparent.id,
      role: 'grandparent',
      joinedAt: at('2019-01-01T00:00:00Z'),
    });

    const items = await readWhatHaleDid(db.database, fam.familyId, fam.parentUserId);
    const when = byId(items, 'a').when;
    // June is ADT (UTC−3): 15:30Z is 12:30 in Halifax.
    expect(when).toContain('12:30');
    expect(when).not.toContain('09:30');
  });

  it('has no zone for a family with no members, and names that without the id', async () => {
    await db.database
      .delete(schema.familyMembers)
      .where(eq(schema.familyMembers.familyId, fam.familyId));

    const failure = await readFamilyOwnTimezone(db.database, fam.familyId).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(FamilyWithoutMembersError);
    expect(String((failure as Error).message)).not.toContain(fam.familyId);
    await expect(readWhatHaleDid(db.database, fam.familyId, null)).rejects.toBeInstanceOf(
      FamilyWithoutMembersError,
    );
  });
});
