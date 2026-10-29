import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { recordActivityBooking } from '~/lib/integrations/booking';
import { reconcileCalendarMirrors } from '~/lib/integrations/calendar-mirror';
import { type TestDb, createTestDb, seedFamily, seedIntegration } from '~/lib/testing/pglite';
import { changeFromColumns } from './change';
import { applyProviderChange } from './provider-change';

/**
 * VIL-474 · the changed fact comes from PROVIDER sources only. A provider move records the
 * field and its old value (so the reminder bolds it); a parent's own calendar mirror
 * records nothing, and nothing from a private calendar is ever stored or read as a change.
 */

let db: TestDb;
const NOW = new Date('2026-10-03T16:00:00.000Z');
const START = new Date('2026-10-04T15:00:00.000Z');
const END = new Date('2026-10-04T16:00:00.000Z');
const TZ = 'America/Toronto';
let family: { familyId: string; parentUserId: string };

beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  family = await seedFamily(db.database);
});

async function seedEmailEvent(): Promise<string> {
  const [row] = await db.database
    .insert(schema.familyEvents)
    .values({
      familyId: family.familyId,
      title: 'Swim',
      startsAt: START,
      endsAt: END,
      location: 'The pool',
      source: 'email',
    })
    .returning({ id: schema.familyEvents.id });
  if (!row) throw new Error('no row');
  return row.id;
}

async function event(id: string) {
  const [row] = await db.database
    .select()
    .from(schema.familyEvents)
    .where(eq(schema.familyEvents.id, id));
  if (!row) throw new Error('no row');
  return row;
}

describe('applyProviderChange', () => {
  it('a provider time move records the field and its old start, moves the end, and bolds', async () => {
    const id = await seedEmailEvent();
    const later = new Date('2026-10-04T16:30:00.000Z');
    const change = await applyProviderChange(db.database, {
      familyId: family.familyId,
      eventId: id,
      source: { startsAt: later, location: null },
      timeZone: TZ,
      now: NOW,
    });
    expect(change).toEqual({ field: 'time', previousStartsAt: START });
    const row = await event(id);
    expect(row.startsAt.toISOString()).toBe(later.toISOString());
    expect(row.endsAt?.toISOString()).toBe('2026-10-04T17:30:00.000Z');
    expect(row.location).toBe('The pool');
    expect(row.sourceChangedField).toBe('time');
    expect(row.sourceChangedFromStartsAt?.toISOString()).toBe(START.toISOString());
    expect(row.sourceChangedFromLocation).toBeNull();
    // The reminder reads exactly this back (run.ts → changeFromColumns): bold fires.
    expect(changeFromColumns(row, NOW)).toEqual({ field: 'time', previousStartsAt: START });
  });

  it('a provider venue change records the old venue', async () => {
    const id = await seedEmailEvent();
    await applyProviderChange(db.database, {
      familyId: family.familyId,
      eventId: id,
      source: { startsAt: START, location: 'Main St pool, 12 Main St' },
      timeZone: TZ,
      now: NOW,
    });
    const row = await event(id);
    expect(row.location).toBe('Main St pool, 12 Main St');
    expect(changeFromColumns(row, NOW)).toEqual({ field: 'venue', previousLocation: 'The pool' });
  });

  it('refuses a Google Calendar mirror row: a private calendar is never a source', async () => {
    const integrationId = await seedIntegration(
      db.database,
      family.familyId,
      family.parentUserId,
      'gcal',
    );
    await reconcileCalendarMirrors(db.database, {
      familyId: family.familyId,
      userId: family.parentUserId,
      integrationId,
      items: [
        {
          id: 'ev-swim',
          status: 'confirmed',
          summary: 'Swim',
          start: { dateTime: START.toISOString() },
          end: { dateTime: END.toISOString() },
          location: 'Private place',
        },
      ],
      timeZone: TZ,
      now: NOW,
      trustWindow: true,
    });
    const [mirror] = await db.database
      .select()
      .from(schema.familyEvents)
      .where(eq(schema.familyEvents.familyId, family.familyId));
    if (!mirror) throw new Error('no mirror');
    const change = await applyProviderChange(db.database, {
      familyId: family.familyId,
      eventId: mirror.id,
      source: { startsAt: START, location: 'Elsewhere' },
      timeZone: TZ,
      now: NOW,
    });
    expect(change).toBeNull();
    const row = await event(mirror.id);
    expect(row.location).toBe('Private place');
    expect(row.sourceChangedField).toBeNull();
    expect(row.sourceChangedFromLocation).toBeNull();
  });
});

describe('registration path (recordActivityBooking refresh)', () => {
  it('a re-sent receipt with a new time moves the linked event and records the change', async () => {
    const integrationId = await seedIntegration(
      db.database,
      family.familyId,
      family.parentUserId,
      'gmail',
    );
    const id = await seedEmailEvent();
    const draft = {
      providerHost: 'markham.ca',
      title: 'Swim Level 2',
      firstSessionAt: START,
      location: 'The pool',
      eventId: id,
      sessionKey: 'k1',
    };
    const base = {
      familyId: family.familyId,
      parentUserId: family.parentUserId,
      integrationId,
      channelMessageId: null,
      timeZone: TZ,
    };
    await recordActivityBooking(db.database, { ...base, messageId: 'm1', draft });
    expect((await event(id)).sourceChangedField).toBeNull();
    const later = new Date('2026-10-04T17:00:00.000Z');
    const second = await recordActivityBooking(db.database, {
      ...base,
      messageId: 'm2',
      draft: { ...draft, firstSessionAt: later, sessionKey: 'k2' },
    });
    expect(second.outcome).toBe('refreshed');
    const row = await event(id);
    expect(row.startsAt.toISOString()).toBe(later.toISOString());
    expect(row.sourceChangedField).toBe('time');
    expect(row.sourceChangedFromStartsAt?.toISOString()).toBe(START.toISOString());
  });
});
