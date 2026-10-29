import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { recordActivityBooking } from '~/lib/integrations/booking';
import { reconcileCalendarMirrors } from '~/lib/integrations/calendar-mirror';
import { recordEmailProviderChange } from '~/lib/integrations/email-alert';
import { correlationMatchCount } from '~/lib/sentinel/correlate';
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
let gmailIntegration: string | undefined;
beforeEach(async () => {
  family = await seedFamily(db.database);
  gmailIntegration = undefined;
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

async function seedEvent(values: {
  title?: string;
  startsAt?: Date;
  source?: 'email' | 'parent' | 'placement';
  createdBy?: string | null;
}): Promise<string> {
  const startsAt = values.startsAt ?? START;
  const [row] = await db.database
    .insert(schema.familyEvents)
    .values({
      familyId: family.familyId,
      title: values.title ?? 'Swim',
      startsAt,
      endsAt: new Date(startsAt.getTime() + 3600_000),
      location: 'The pool',
      source: values.source ?? 'email',
      createdBy: values.createdBy ?? null,
    })
    .returning({ id: schema.familyEvents.id });
  if (!row) throw new Error('no row');
  return row.id;
}

/** Link `eventId` to a booking from `host`, so the event is provider-owned. */
async function linkBooking(
  eventId: string,
  opts: { host?: string; firstSessionAt?: Date; messageId?: string; title?: string } = {},
) {
  gmailIntegration ??= await seedIntegration(
    db.database,
    family.familyId,
    family.parentUserId,
    'gmail',
  );
  const integrationId = gmailIntegration;
  const base = {
    familyId: family.familyId,
    parentUserId: family.parentUserId,
    integrationId,
    channelMessageId: null,
    timeZone: TZ,
  };
  const draft = {
    providerHost: opts.host ?? HOST,
    title: opts.title ?? 'Swim Level 2',
    firstSessionAt: opts.firstSessionAt ?? START,
    location: 'The pool',
    eventId,
    sessionKey: `k-${eventId}`,
  };
  await recordActivityBooking(db.database, { ...base, messageId: opts.messageId ?? 'm1', draft });
  return { base, draft };
}

const HOST = 'markham.ca';
const PROVIDER_FROM = 'Markham Recreation <noreply@markham.ca>';
const LATER = new Date('2026-10-04T16:30:00.000Z');

function reschedule(
  eventId: string,
  over: Partial<{
    newTime: string | null;
    location: string | null;
    sourceConfidence: number;
    matchedEventCount: number;
  }> = {},
) {
  return {
    kind: 'reschedule' as const,
    event: {
      newTime: over.newTime === undefined ? '2026-10-04T12:30:00-04:00' : over.newTime,
      location: over.location ?? null,
    },
    sourceConfidence: over.sourceConfidence ?? 0.92,
    matchedEventRef: { table: 'family_events' as const, id: eventId },
    matchedEventCount: over.matchedEventCount ?? 1,
  };
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
    await linkBooking(id);
    const change = await applyProviderChange(db.database, {
      familyId: family.familyId,
      eventId: id,
      providerHost: HOST,
      source: { startsAt: LATER, location: null },
      timeZone: TZ,
      now: NOW,
      move: true,
    });
    expect(change).toEqual({ field: 'time', previousStartsAt: START });
    const row = await event(id);
    expect(row.startsAt.toISOString()).toBe(LATER.toISOString());
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
    await linkBooking(id);
    await applyProviderChange(db.database, {
      familyId: family.familyId,
      eventId: id,
      providerHost: HOST,
      source: { startsAt: START, location: 'Main St pool, 12 Main St' },
      timeZone: TZ,
      now: NOW,
      move: true,
    });
    const row = await event(id);
    expect(row.location).toBe('Main St pool, 12 Main St');
    expect(changeFromColumns(row, NOW)).toEqual({ field: 'venue', previousLocation: 'The pool' });
  });

  it('time and venue changing together keeps both (review point 6)', async () => {
    const id = await seedEmailEvent();
    await linkBooking(id);
    const change = await applyProviderChange(db.database, {
      familyId: family.familyId,
      eventId: id,
      providerHost: HOST,
      source: { startsAt: LATER, location: 'Main St pool' },
      timeZone: TZ,
      now: NOW,
      move: true,
    });
    expect(change).toEqual({
      field: 'time',
      previousStartsAt: START,
      previousLocation: 'The pool',
    });
    const row = await event(id);
    expect(row.startsAt.toISOString()).toBe(LATER.toISOString());
    expect(row.location).toBe('Main St pool');
    expect(row.sourceChangedFromStartsAt?.toISOString()).toBe(START.toISOString());
    expect(row.sourceChangedFromLocation).toBe('The pool');
    expect(changeFromColumns(row, NOW)).toEqual(change);
  });

  it('refuses a parent-created event even when a booking links it (review point 4)', async () => {
    const id = await seedEvent({ source: 'parent' });
    await linkBooking(id);
    const owned = await seedEvent({ source: 'placement', createdBy: family.parentUserId });
    await linkBooking(owned, { messageId: 'm-owned', title: 'Swim Level 3' });
    for (const eventId of [id, owned]) {
      const change = await applyProviderChange(db.database, {
        familyId: family.familyId,
        eventId,
        providerHost: HOST,
        source: { startsAt: LATER, location: null },
        timeZone: TZ,
        now: NOW,
        move: true,
      });
      expect(change).toBeNull();
      const row = await event(eventId);
      expect(row.startsAt.toISOString()).toBe(START.toISOString());
      expect(row.sourceChangedField).toBeNull();
    }
  });

  it('refuses an event no booking from this provider links', async () => {
    const id = await seedEmailEvent();
    const unlinked = await applyProviderChange(db.database, {
      familyId: family.familyId,
      eventId: id,
      providerHost: HOST,
      source: { startsAt: LATER, location: null },
      timeZone: TZ,
      now: NOW,
      move: true,
    });
    expect(unlinked).toBeNull();
    await linkBooking(id, { host: 'other.example' });
    const otherHost = await applyProviderChange(db.database, {
      familyId: family.familyId,
      eventId: id,
      providerHost: HOST,
      source: { startsAt: LATER, location: null },
      timeZone: TZ,
      now: NOW,
      move: true,
    });
    expect(otherHost).toBeNull();
    expect((await event(id)).sourceChangedField).toBeNull();
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
    await linkBooking(mirror.id);
    const change = await applyProviderChange(db.database, {
      familyId: family.familyId,
      eventId: mirror.id,
      providerHost: HOST,
      source: { startsAt: START, location: 'Elsewhere' },
      timeZone: TZ,
      now: NOW,
      move: true,
    });
    expect(change).toBeNull();
    const row = await event(mirror.id);
    expect(row.location).toBe('Private place');
    expect(row.sourceChangedField).toBeNull();
    expect(row.sourceChangedFromLocation).toBeNull();
  });
});

describe('registration path (recordActivityBooking refresh)', () => {
  it('a re-sent receipt with a new time moves the linked first-session event and records it', async () => {
    const id = await seedEmailEvent();
    const { base, draft } = await linkBooking(id);
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

  it('never moves a later session onto the first-session date (review point 7)', async () => {
    const weekTwo = new Date('2026-10-11T15:00:00.000Z');
    const id = await seedEvent({ startsAt: weekTwo });
    const { base, draft } = await linkBooking(id);
    const later = new Date('2026-10-04T17:00:00.000Z');
    const second = await recordActivityBooking(db.database, {
      ...base,
      messageId: 'm2',
      draft: { ...draft, firstSessionAt: later, sessionKey: 'k2' },
    });
    expect(second.outcome).toBe('refreshed');
    const row = await event(id);
    expect(row.startsAt.toISOString()).toBe(weekTwo.toISOString());
    expect(row.sourceChangedField).toBeNull();
  });
});

describe('email path (recordEmailProviderChange): record only, nothing moves', () => {
  async function run(eventId: string, from: string, over: Parameters<typeof reschedule>[1] = {}) {
    return recordEmailProviderChange(db.database, {
      familyId: family.familyId,
      from,
      extraction: reschedule(eventId, over),
      timeZone: TZ,
      now: NOW,
    });
  }

  it('records the field and old value, and leaves the event where it is', async () => {
    const id = await seedEmailEvent();
    await linkBooking(id);
    const change = await run(id, PROVIDER_FROM);
    expect(change).toEqual({ field: 'time', previousStartsAt: START });
    const row = await event(id);
    expect(row.startsAt.toISOString()).toBe(START.toISOString());
    expect(row.endsAt?.toISOString()).toBe(END.toISOString());
    expect(row.location).toBe('The pool');
    expect(changeFromColumns(row, NOW)).toEqual({ field: 'time', previousStartsAt: START });
  });

  it('a combined time and venue change records both, and moves neither', async () => {
    const id = await seedEmailEvent();
    await linkBooking(id);
    const change = await run(id, PROVIDER_FROM, { location: 'Main St pool' });
    expect(change).toEqual({
      field: 'time',
      previousStartsAt: START,
      previousLocation: 'The pool',
    });
    const row = await event(id);
    expect(row.startsAt.toISOString()).toBe(START.toISOString());
    expect(row.location).toBe('The pool');
    expect(row.sourceChangedFromLocation).toBe('The pool');
  });

  it('two passing candidates record nothing', async () => {
    const id = await seedEmailEvent();
    await linkBooking(id);
    expect(await run(id, PROVIDER_FROM, { matchedEventCount: 2 })).toBeNull();
    expect((await event(id)).sourceChangedField).toBeNull();
    // And the count itself: two "Swim" rows inside the window both pass.
    const input = {
      kind: 'reschedule' as const,
      title: 'Swim lesson moved',
      originalTime: START.toISOString(),
      newTime: LATER.toISOString(),
    };
    const candidate = (cid: string, title: string) => ({
      ref: { table: 'family_events' as const, id: cid },
      title,
      startsAt: START.toISOString(),
    });
    expect(
      correlationMatchCount(input, [candidate('a', 'Swim'), candidate('b', 'Swim lesson')]),
    ).toBe(2);
  });

  it('a low-confidence extraction records nothing', async () => {
    const id = await seedEmailEvent();
    await linkBooking(id);
    expect(await run(id, PROVIDER_FROM, { sourceConfidence: 0.6 })).toBeNull();
    expect((await event(id)).sourceChangedField).toBeNull();
  });

  it('a parent-created event records nothing', async () => {
    const id = await seedEvent({ source: 'parent', createdBy: family.parentUserId });
    await linkBooking(id);
    expect(await run(id, PROVIDER_FROM)).toBeNull();
    expect((await event(id)).sourceChangedField).toBeNull();
  });

  it('a Google Calendar notification records nothing', async () => {
    const id = await seedEmailEvent();
    await linkBooking(id, { host: 'google.com' });
    expect(await run(id, 'Google Calendar <calendar-notification@google.com>')).toBeNull();
    expect((await event(id)).sourceChangedField).toBeNull();
  });

  it('a new time without a UTC offset is ignored, never read as UTC (review point 8)', async () => {
    const id = await seedEmailEvent();
    await linkBooking(id);
    expect(await run(id, PROVIDER_FROM, { newTime: '2026-10-04T12:30:00' })).toBeNull();
    expect((await event(id)).sourceChangedField).toBeNull();
  });

  it('a French title correlates and records; an all-Chinese title never correlates', async () => {
    const id = await seedEvent({ title: 'Natation niveau 2' });
    await linkBooking(id);
    const candidates = [
      {
        ref: { table: 'family_events' as const, id },
        title: 'Natation niveau 2',
        startsAt: START.toISOString(),
      },
    ];
    const fr = {
      kind: 'reschedule' as const,
      title: 'Natation niveau 2 : séance déplacée',
      originalTime: START.toISOString(),
      newTime: LATER.toISOString(),
    };
    expect(correlationMatchCount(fr, candidates)).toBe(1);
    expect(await run(id, PROVIDER_FROM, { matchedEventCount: 1 })).toEqual({
      field: 'time',
      previousStartsAt: START,
    });
    expect((await event(id)).startsAt.toISOString()).toBe(START.toISOString());
    // The tokenizer keeps a-z0-9 only, so a Chinese title has no tokens: zero matches,
    // which the email path treats as "record nothing" rather than a guess.
    const zh = { ...fr, title: '游泳课改时间' };
    const zhCandidates = candidates.map((c) => ({ ...c, title: '游泳课' }));
    expect(correlationMatchCount(zh, zhCandidates)).toBe(0);
  });
});
