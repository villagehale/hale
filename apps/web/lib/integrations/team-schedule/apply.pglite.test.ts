import { randomUUID } from 'node:crypto';
import { schema } from '@hale/db';
import type { CalendarPlacementPayload } from '@hale/types';
import { eq } from 'drizzle-orm';
import type { Database } from '@hale/db';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
  calendarKindAutonomous,
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

/** VIL-719 · every page a test's ports were asked to send. */
const pages: unknown[] = [];

beforeEach(async () => {
  family = await seedFamily(db.database);
  childId = await seedChild(db.database, family.familyId, 'Leo', 96);
  delete process.env[TEAM_SCHEDULE_CHANGES_ENABLED_ENV];
  pages.length = 0;
});

afterEach(() => {
  delete process.env[TEAM_SCHEDULE_CHANGES_ENABLED_ENV];
  vi.unstubAllEnvs();
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

/** What the real executor leaves on the row when a change lands. */
async function markExecuted(actionId: string): Promise<void> {
  await db.database
    .update(schema.actions)
    .set({ userVisibleState: 'autonomous', executedAt: NOW })
    .where(eq(schema.actions.id, actionId));
}

function ports(over: {
  match?: ScheduleMatch;
  parentText?: string | null;
  autonomous?: boolean;
  /** False: the executor refused it (outside the action window) and the row stays drafted. */
  executes?: boolean;
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
    execute: async (actionId) => {
      if (over.executes !== false) await markExecuted(actionId);
    },
    gate: async () => ({ allowed: true, optOut: 'short' }),
    resolvePhone: async () => '+14165550100',
    transport,
    threadMessage: async () => 'conv-1',
    parentLanguage: async () => 'en',
    pager: {
      page: async (page) => {
        pages.push(page);
        return 'paged';
      },
    },
    driver: {
      composeDriver: async () => 'Pickup moved to 2.',
      gate: async () => ({ allowed: true, optOut: 'short' }),
      resolvePhone: async () => '+14165550100',
      transport,
      sendChat: async () => ({ providerMessageId: 'chat-out-1' }),
      threadMessage: async () => 'conv-1',
      clock: () => NOW,
      pager: {
        page: async (page) => {
          pages.push(page);
          return 'paged';
        },
      },
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

  it('VIL-719 policy on: an applied change whose text cannot be written pages #ops once', async () => {
    process.env[TEAM_SCHEDULE_CHANGES_ENABLED_ENV] = 'true';
    vi.stubEnv('ASK_POLICY_TIERS_ENABLED', 'true');
    const eventId = await seedGame();
    const transportPorts = ports({
      match: { eventId, change: 'time', newStartsAt: NEW_START.toISOString(), newLocation: null },
      parentText: null,
      autonomous: true,
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
        classification: classified(),
        children: children(),
      },
      transportPorts,
    );
    expect(result).toEqual({ handled: true, outcome: 'schedule_change_unwritten' });
    expect(pages).toEqual([
      { site: 'team_schedule_unwritten', facts: { change: 'time' }, ref: expect.any(String) },
    ]);
  });

  it('VIL-719 policy off: the same unwritten text pages no one', async () => {
    process.env[TEAM_SCHEDULE_CHANGES_ENABLED_ENV] = 'true';
    vi.stubEnv('ASK_POLICY_TIERS_ENABLED', 'false');
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
        match: { eventId, change: 'time', newStartsAt: NEW_START.toISOString(), newLocation: null },
        parentText: null,
        autonomous: true,
      }),
    );
    expect(result).toEqual({ handled: true, outcome: 'schedule_change_unwritten' });
    expect(pages).toEqual([]);
  });

  it('VIL-719 policy on: an ask with no text applied nothing and pages no one', async () => {
    process.env[TEAM_SCHEDULE_CHANGES_ENABLED_ENV] = 'true';
    vi.stubEnv('ASK_POLICY_TIERS_ENABLED', 'true');
    const eventId = await seedGame();
    await applyTeamScheduleChange(
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
        match: { eventId, change: 'cancel', newStartsAt: null, newLocation: null },
        parentText: null,
      }),
    );
    expect(pages).toEqual([]);
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
    await markExecuted(drafted.actionId);
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

describe('VIL-719 the driver text after an applied change', () => {
  async function applyWithDriverText(text: string | null) {
    const eventId = await seedGame({ dutyOwnerUserId: family.parentUserId });
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
    await markExecuted(drafted.actionId);
    const base = ports({}).driver;
    const transport = new FakeTransport();
    const composeDriver = vi.fn(async () => text);
    await applyTeamScheduleEffects(
      db.database,
      { actionId: drafted.actionId, familyId: family.familyId, now: NOW },
      { ...base, transport, composeDriver },
    );
    return { actionId: drafted.actionId, transport, composeDriver };
  }

  it('policy on: a text the model could not write sends nothing and pages #ops', async () => {
    vi.stubEnv('ASK_POLICY_TIERS_ENABLED', 'true');
    const { actionId, transport, composeDriver } = await applyWithDriverText(null);
    expect(composeDriver).toHaveBeenCalledTimes(1);
    expect(transport.sent).toEqual([]);
    expect(pages).toEqual([
      { site: 'team_schedule_driver_unwritten', facts: { change: 'time' }, ref: actionId },
    ]);
  });

  it('policy off: the same unwritten text pages no one', async () => {
    vi.stubEnv('ASK_POLICY_TIERS_ENABLED', 'false');
    const { transport } = await applyWithDriverText(null);
    expect(transport.sent).toEqual([]);
    expect(pages).toEqual([]);
  });

  it('positive control, policy on: a written text is sent and pages no one', async () => {
    vi.stubEnv('ASK_POLICY_TIERS_ENABLED', 'true');
    const { transport } = await applyWithDriverText('Pickup moved to 2.');
    expect(transport.sent).toHaveLength(1);
    expect(pages).toEqual([]);
  });
});

describe('VIL-719 a change the executor did not run', () => {
  const REMINDER_AT = new Date(START.getTime() - 3600_000);

  async function seedReminder(eventId: string) {
    const [reminder] = await db.database
      .insert(schema.eventReminders)
      .values({
        familyId: family.familyId,
        eventRef: eventId,
        parentUserId: family.parentUserId,
        offset: '-PT1H',
        fireAt: REMINDER_AT,
        status: 'scheduled',
      })
      .returning({ id: schema.eventReminders.id });
    if (!reminder) throw new Error('no reminder');
    return reminder.id;
  }

  async function reminderFireAt(reminderId: string) {
    const [row] = await db.database
      .select({ fireAt: schema.eventReminders.fireAt })
      .from(schema.eventReminders)
      .where(eq(schema.eventReminders.id, reminderId));
    return row?.fireAt.toISOString();
  }

  async function effectsStamp() {
    const rows = await db.database
      .select({ effectsAppliedAt: schema.teamScheduleChanges.effectsAppliedAt })
      .from(schema.teamScheduleChanges)
      .where(eq(schema.teamScheduleChanges.familyId, family.familyId));
    return rows.map((row) => row.effectsAppliedAt);
  }

  async function applyUnderGrant(eventId: string, executes: boolean) {
    process.env[TEAM_SCHEDULE_CHANGES_ENABLED_ENV] = 'true';
    const p = ports({
      match: { eventId, change: 'time', newStartsAt: NEW_START.toISOString(), newLocation: null },
      parentText: 'Leo’s hockey moved to 2.',
      autonomous: true,
      executes,
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
        classification: classified(),
        children: children(),
      },
      p,
    );
    return { result, sent: (p.transport as FakeTransport).sent };
  }

  it('policy on: nobody is told it moved, reminders stay, and the draft waits', async () => {
    vi.stubEnv('ASK_POLICY_TIERS_ENABLED', 'true');
    const eventId = await seedGame({ dutyOwnerUserId: family.parentUserId });
    const reminderId = await seedReminder(eventId);
    const { result, sent } = await applyUnderGrant(eventId, false);
    expect(result).toEqual({ handled: true, outcome: 'schedule_change_not_applied' });
    expect(sent).toEqual([]);
    expect(pages).toEqual([]);
    expect(await reminderFireAt(reminderId)).toBe(REMINDER_AT.toISOString());
    expect(await effectsStamp()).toEqual([null]);
    const actions = await db.database
      .select({ state: schema.actions.userVisibleState })
      .from(schema.actions)
      .where(eq(schema.actions.familyId, family.familyId));
    expect(actions.map((row) => row.state)).toEqual(['drafted_for_approval']);
  });

  it('positive control, policy on: a change that ran is told and its effects land', async () => {
    vi.stubEnv('ASK_POLICY_TIERS_ENABLED', 'true');
    const eventId = await seedGame({ dutyOwnerUserId: family.parentUserId });
    const reminderId = await seedReminder(eventId);
    const { result, sent } = await applyUnderGrant(eventId, true);
    expect(result).toEqual({ handled: true, outcome: 'schedule_change_applied' });
    expect(sent.length).toBeGreaterThan(0);
    expect(await reminderFireAt(reminderId)).toBe(
      new Date(NEW_START.getTime() - 3600_000).toISOString(),
    );
  });

  it('policy off: the same refusal still runs the effects and the text, as today', async () => {
    vi.stubEnv('ASK_POLICY_TIERS_ENABLED', 'false');
    const eventId = await seedGame({ dutyOwnerUserId: family.parentUserId });
    const reminderId = await seedReminder(eventId);
    const { result, sent } = await applyUnderGrant(eventId, false);
    expect(result).toEqual({ handled: true, outcome: 'schedule_change_applied' });
    expect(sent.length).toBeGreaterThan(0);
    expect(await reminderFireAt(reminderId)).toBe(
      new Date(NEW_START.getTime() - 3600_000).toISOString(),
    );
  });

  it('policy on: the approval path applies effects only once the change has run', async () => {
    vi.stubEnv('ASK_POLICY_TIERS_ENABLED', 'true');
    const eventId = await seedGame();
    const reminderId = await seedReminder(eventId);
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
    expect(await reminderFireAt(reminderId)).toBe(REMINDER_AT.toISOString());
    expect(await effectsStamp()).toEqual([null]);

    await markExecuted(drafted.actionId);
    await applyTeamScheduleEffects(db.database, {
      actionId: drafted.actionId,
      familyId: family.familyId,
      now: NOW,
    });
    expect(await reminderFireAt(reminderId)).toBe(
      new Date(NEW_START.getTime() - 3600_000).toISOString(),
    );
    expect(await effectsStamp()).toEqual([NOW]);
  });
});

describe('VIL-719 calendarKindAutonomous never carries an ask-first kind', () => {
  it('policy on: an ask-first kind is refused before any standing is read', async () => {
    vi.stubEnv('AUTONOMOUS_EXECUTE_ENABLED', 'true');
    vi.stubEnv('ASK_POLICY_TIERS_ENABLED', 'true');
    // A database that throws on any read proves the refusal reads no standing.
    const untouched = new Proxy({}, {
      get() {
        throw new Error('read the database');
      },
    }) as Database;
    expect(await calendarKindAutonomous(untouched, family.familyId, 'send_email', NOW)).toEqual({
      autonomous: false,
      parentUserId: null,
    });
  });

  it('policy off: the same kind goes on to the standing checks', async () => {
    vi.stubEnv('AUTONOMOUS_EXECUTE_ENABLED', 'true');
    vi.stubEnv('ASK_POLICY_TIERS_ENABLED', 'false');
    const untouched = new Proxy({}, {
      get() {
        throw new Error('read the database');
      },
    }) as Database;
    await expect(
      calendarKindAutonomous(untouched, family.familyId, 'send_email', NOW),
    ).rejects.toThrow('read the database');
  });
});
