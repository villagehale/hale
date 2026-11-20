import { randomUUID } from 'node:crypto';
import { schema } from '@hale/db';
import type { CalendarPlacementPayload } from '@hale/types';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FakeTransport } from '~/lib/channel/intake/transport';
import {
  type TestDb,
  createTestDb,
  seedChild,
  seedFamily,
} from '~/lib/testing/pglite';
import {
  type TeamScheduleApplyPorts,
  applyTeamScheduleChange,
  applyTeamScheduleEffects,
} from './apply';
import { TEAM_SCHEDULE_CHANGES_ENABLED_ENV } from './flag';
import type { ScheduleMatch } from './match';
import type { FamilyChildRef, SentinelClassification } from '~/lib/sentinel';

let db: TestDb;
let family: { familyId: string; parentUserId: string };
let childId: string;

const NOW = new Date('2026-11-14T15:00:00.000Z');
const START = new Date('2026-11-15T18:00:00.000Z');
const NEW_START = new Date('2026-11-15T19:00:00.000Z');
const TZ = 'America/Toronto';

beforeAll(async () => {
  process.env.APP_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  family = await seedFamily(db.database);
  childId = await seedChild(db.database, family.familyId, 'Leo', 96);
  delete process.env[TEAM_SCHEDULE_CHANGES_ENABLED_ENV];
});

afterEach(() => {
  delete process.env[TEAM_SCHEDULE_CHANGES_ENABLED_ENV];
});

async function seedGame(over: { location?: string; dutyOwnerUserId?: string } = {}) {
  const [row] = await db.database
    .insert(schema.familyEvents)
    .values({
      familyId: family.familyId,
      childId,
      title: 'U11 Lightning',
      startsAt: START,
      endsAt: new Date(START.getTime() + 3600_000),
      location: over.location ?? 'Rink 1',
      source: 'email',
      dutyOwnerUserId: over.dutyOwnerUserId ?? null,
    })
    .returning({ id: schema.familyEvents.id });
  if (!row) throw new Error('no event');
  return row.id;
}

function classified(
  over: Partial<SentinelClassification['extraction']> & {
    kind?: NonNullable<SentinelClassification['extraction']>['kind'];
  } = {},
): SentinelClassification {
  const { kind = 'reschedule', ...rest } = over;
  return {
    status: 'classified',
    familyId: family.familyId,
    messageId: 'gmail-1',
    extraction: {
      kind,
      event: {
        title: 'U11 Lightning',
        childRef: childId,
        originalTime: START.toISOString(),
        newTime: NEW_START.toISOString(),
        location: 'Rink 1',
        address: null,
      },
      sourceConfidence: 0.9,
      quoteEvidence: 'practice moves to 2pm',
      teenContent: false,
      teenAttributed: false,
      matchedEventRef: null,
      ...rest,
    },
    usage: { triage: { promptTokens: 1, completionTokens: 1 }, extract: null },
  };
}

function children(): FamilyChildRef[] {
  return [{ id: childId, name: 'Leo', ageInMonths: 96 }];
}

async function draftAction(): Promise<{ actionId: string }> {
  const [event] = await db.database
    .insert(schema.events)
    .values({
      familyId: family.familyId,
      source: 'channel_sms',
      eventType: 'channel_sms.calendar_intent',
      dedupHash: randomUUID(),
    })
    .returning({ id: schema.events.id });
  if (!event) throw new Error('no event');
  const [action] = await db.database
    .insert(schema.actions)
    .values({
      familyId: family.familyId,
      eventId: event.id,
      actionType: 'calendar_move',
      payload: {},
      userVisibleState: 'drafted_for_approval',
      reviewerVerdict: 'approved',
    })
    .returning({ id: schema.actions.id });
  if (!action) throw new Error('no action');
  return { actionId: action.id };
}

function ports(over: {
  match?: ScheduleMatch;
  parentText?: string | null;
  autonomous?: boolean;
  payloads?: CalendarPlacementPayload[];
}): TeamScheduleApplyPorts {
  const transport = new FakeTransport();
  const payloads: CalendarPlacementPayload[] = over.payloads ?? [];
  return {
    match: async () =>
      over.match ?? {
        eventId: null,
        change: 'none',
        newStartsAt: null,
        newLocation: null,
      },
    composeParent: async () => (over.parentText === undefined ? 'Leo’s hockey moved. Want me to update it?' : over.parentText),
    draft: async (input) => {
      payloads.push(input.payload);
      return draftAction();
    },
    autonomous: async () => ({
      autonomous: over.autonomous === true,
      parentUserId: over.autonomous ? family.parentUserId : null,
    }),
    execute: async () => undefined,
    gate: async () => ({ allowed: true, optOut: 'short' }),
    resolvePhone: async () => '+14165550100',
    transport,
    threadMessage: async () => 'conv-1',
    parentLanguage: async () => 'en',
    driver: {
      composeDriver: async () => 'Pickup moved to 2.',
      gate: async () => ({ allowed: true, optOut: 'short' }),
      resolvePhone: async () => '+14165550100',
      transport,
      threadMessage: async () => 'conv-1',
    },
  };
}

describe('applyTeamScheduleChange', () => {
  it('does nothing while the flag is off', async () => {
    const eventId = await seedGame();
    const result = await applyTeamScheduleChange(
      db.database,
      {
        familyId: family.familyId,
        parentUserId: family.parentUserId,
        integrationId: randomUUID(),
        messageId: 'gmail-1',
        timeZone: TZ,
        now: NOW,
        classification: classified(),
        children: children(),
      },
      ports({
        match: {
          eventId,
          change: 'time',
          newStartsAt: NEW_START.toISOString(),
          newLocation: null,
        },
      }),
    );
    expect(result).toEqual({ handled: false });
  });

  it('falls through when the model does not match an event', async () => {
    process.env[TEAM_SCHEDULE_CHANGES_ENABLED_ENV] = 'true';
    await seedGame();
    const result = await applyTeamScheduleChange(
      db.database,
      {
        familyId: family.familyId,
        parentUserId: family.parentUserId,
        integrationId: randomUUID(),
        messageId: 'gmail-1',
        timeZone: TZ,
        now: NOW,
        classification: classified(),
        children: children(),
      },
      ports({}),
    );
    expect(result).toEqual({ handled: false });
  });

  it('asks the parent to move a matched time change and does not set updateLocation', async () => {
    process.env[TEAM_SCHEDULE_CHANGES_ENABLED_ENV] = 'true';
    const eventId = await seedGame();
    const payloads: CalendarPlacementPayload[] = [];
    const result = await applyTeamScheduleChange(
      db.database,
      {
        familyId: family.familyId,
        parentUserId: family.parentUserId,
        integrationId: randomUUID(),
        messageId: 'gmail-1',
        timeZone: TZ,
        now: NOW,
        classification: classified(),
        children: children(),
      },
      ports({
        match: {
          eventId,
          change: 'time',
          newStartsAt: NEW_START.toISOString(),
          newLocation: null,
        },
        payloads,
      }),
    );
    expect(result).toEqual({ handled: true, outcome: 'schedule_change_asked' });
    expect(payloads[0]?.updateLocation).toBeUndefined();
    expect(payloads[0]?.startsAt).toBe(NEW_START.toISOString());
    const [row] = await db.database
      .select()
      .from(schema.teamScheduleChanges)
      .where(eq(schema.teamScheduleChanges.familyEventId, eventId));
    expect(row?.changeKind).toBe('time');
    expect(row?.effectsAppliedAt).toBeNull();
  });

  it('sets updateLocation on a rink change', async () => {
    process.env[TEAM_SCHEDULE_CHANGES_ENABLED_ENV] = 'true';
    const eventId = await seedGame();
    const payloads: CalendarPlacementPayload[] = [];
    await applyTeamScheduleChange(
      db.database,
      {
        familyId: family.familyId,
        parentUserId: family.parentUserId,
        integrationId: randomUUID(),
        messageId: 'gmail-1',
        timeZone: TZ,
        now: NOW,
        classification: classified({
          kind: 'reschedule',
          event: {
            title: 'U11 Lightning',
            childRef: childId,
            originalTime: START.toISOString(),
            newTime: START.toISOString(),
            location: 'Rink 2',
            address: null,
          },
        }),
        children: children(),
      },
      ports({
        match: {
          eventId,
          change: 'location',
          newStartsAt: null,
          newLocation: 'Rink 2',
        },
        payloads,
      }),
    );
    expect(payloads[0]?.updateLocation).toBe(true);
    expect(payloads[0]?.location).toBe('Rink 2');
  });

  it('sends nothing when the parent text cannot be written', async () => {
    process.env[TEAM_SCHEDULE_CHANGES_ENABLED_ENV] = 'true';
    const eventId = await seedGame();
    const result = await applyTeamScheduleChange(
      db.database,
      {
        familyId: family.familyId,
        parentUserId: family.parentUserId,
        integrationId: randomUUID(),
        messageId: 'gmail-1',
        timeZone: TZ,
        now: NOW,
        classification: classified(),
        children: children(),
      },
      ports({
        match: {
          eventId,
          change: 'cancel',
          newStartsAt: null,
          newLocation: null,
        },
        parentText: null,
      }),
    );
    expect(result).toEqual({ handled: true, outcome: 'schedule_change_unwritten' });
  });

  it('does not follow a planted phone or link in the extraction', async () => {
    process.env[TEAM_SCHEDULE_CHANGES_ENABLED_ENV] = 'true';
    const eventId = await seedGame();
    const payloads: CalendarPlacementPayload[] = [];
    let seenPlace: string | null | undefined;
    const base = ports({
      match: {
        eventId,
        change: 'time',
        newStartsAt: NEW_START.toISOString(),
        newLocation: null,
      },
      payloads,
    });
    const result = await applyTeamScheduleChange(
      db.database,
      {
        familyId: family.familyId,
        parentUserId: family.parentUserId,
        integrationId: randomUUID(),
        messageId: 'gmail-1',
        timeZone: TZ,
        now: NOW,
        classification: classified({
          event: {
            title: 'U11 Lightning https://evil.example/x',
            childRef: childId,
            originalTime: START.toISOString(),
            newTime: NEW_START.toISOString(),
            location: 'Call 416-555-0199',
            address: 'bit.ly/pay',
          },
        }),
        children: children(),
      },
      {
        ...base,
        match: async (input) => {
          seenPlace = input.facts.place;
          expect(input.facts.team).toBeNull();
          return {
            eventId,
            change: 'time',
            newStartsAt: NEW_START.toISOString(),
            newLocation: null,
          };
        },
      },
    );
    expect(result.handled).toBe(true);
    expect(seenPlace).toBeNull();
    expect(payloads[0]?.location).toBe('Rink 1');
  });
});

describe('applyTeamScheduleEffects', () => {
  it('re-anchors a scheduled reminder onto the new start', async () => {
    const eventId = await seedGame();
    const [reminder] = await db.database
      .insert(schema.eventReminders)
      .values({
        familyId: family.familyId,
        eventRef: eventId,
        parentUserId: family.parentUserId,
        offset: '-PT1H',
        fireAt: new Date(START.getTime() - 3600_000),
        status: 'scheduled',
      })
      .returning({ id: schema.eventReminders.id });
    if (!reminder) throw new Error('no reminder');
    const drafted = await draftAction();
    await db.database.insert(schema.teamScheduleChanges).values({
      familyId: family.familyId,
      actionId: drafted.actionId,
      familyEventId: eventId,
      gmailMessageId: 'gmail-1',
      changeKind: 'time',
      originalStartsAt: START,
      timeZone: TZ,
      newStartsAt: NEW_START,
    });
    await applyTeamScheduleEffects(db.database, {
      actionId: drafted.actionId,
      familyId: family.familyId,
      now: NOW,
    });
    const [moved] = await db.database
      .select({ fireAt: schema.eventReminders.fireAt })
      .from(schema.eventReminders)
      .where(eq(schema.eventReminders.id, reminder.id));
    expect(moved?.fireAt.toISOString()).toBe(new Date(NEW_START.getTime() - 3600_000).toISOString());
  });
});
