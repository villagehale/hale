import { randomUUID } from 'node:crypto';
import { schema } from '@hale/db';
import type { CalendarPlacementPayload } from '@hale/types';
import { recordExecution } from '@hale/worker/memory-writer';
import { and, eq } from 'drizzle-orm';
import type { Database } from '@hale/db';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mintChannelCalendarDraft } from '~/lib/channel/coach/draft';
import { FakeTransport } from '~/lib/channel/intake/transport';
import { defaultApprovalSpine } from '~/lib/channel/router/wiring';
import { loadTrailForFamily } from '~/lib/dashboard/trail-query';
import { AUDIT_LOG_AUDIENCE_ENABLED_ENV } from '~/lib/privacy/audit-audience';
import { assembleFamilyExport } from '~/lib/rights/export';
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

async function draftAction(heldUntilAsked = false): Promise<{ actionId: string }> {
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
      userVisibleState: heldUntilAsked ? 'needs_human' : 'drafted_for_approval',
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
  /** The executor ran it and it failed: the row the real recordExecution leaves. */
  executionFails?: boolean;
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
      return draftAction(input.heldUntilAsked);
    },
    autonomous: async () => ({
      autonomous: over.autonomous === true,
      parentUserId: over.autonomous ? family.parentUserId : null,
    }),
    execute: async (actionId) => {
      if (over.executionFails) {
        await recordExecution(
          {
            actionId,
            result: { error: 'provider failed' },
            ok: false,
            decision: { source: 'human', reason: 'grant' },
          },
          db.database,
        );
        return;
      }
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
    const [change] = await db.database
      .insert(schema.teamScheduleChanges)
      .values({
        familyId: family.familyId,
        actionId: drafted.actionId,
        familyEventId: eventId,
        gmailMessageId: 'gmail-1',
        changeKind: 'time',
        originalStartsAt: START,
        timeZone: TZ,
        newStartsAt: NEW_START,
      })
      .returning({ id: schema.teamScheduleChanges.id });
    await markExecuted(drafted.actionId);
    const base = ports({}).driver;
    const transport = new FakeTransport();
    const composeDriver = vi.fn(async () => text);
    await applyTeamScheduleEffects(
      db.database,
      { actionId: drafted.actionId, familyId: family.familyId, now: NOW },
      { ...base, transport, composeDriver },
    );
    return { changeId: change?.id, transport, composeDriver };
  }

  it('policy on: a text the model could not write sends nothing and pages #ops', async () => {
    vi.stubEnv('ASK_POLICY_TIERS_ENABLED', 'true');
    vi.stubEnv('TEAM_SCHEDULE_SEND_RECEIPT_ENABLED', 'false');
    const { changeId, transport, composeDriver } = await applyWithDriverText(null);
    expect(composeDriver).toHaveBeenCalledTimes(1);
    expect(transport.sent).toEqual([]);
    expect(pages).toEqual([
      { site: 'team_schedule_driver_unwritten', facts: { change: 'time' }, ref: changeId },
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

/** The one row that says a change from this parent's email did not run. */
async function notRunRows() {
  return db.database
    .select({
      audience: schema.auditLog.audience,
      targetTable: schema.auditLog.targetTable,
      targetId: schema.auditLog.targetId,
      after: schema.auditLog.after,
    })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.familyId, family.familyId),
        eq(schema.auditLog.actionTaken, 'team_schedule_change_not_run'),
      ),
    );
}

describe('VIL-719 an ask that never reached the parent', () => {
  class RefusingTransport extends FakeTransport {
    override async send(): Promise<{ providerMessageId: string }> {
      throw new Error('provider unavailable');
    }
  }

  async function applyAsk(
    eventId: string,
    adjust: (p: TeamScheduleApplyPorts) => void = () => {},
    integrationId: string = randomUUID(),
  ) {
    process.env[TEAM_SCHEDULE_CHANGES_ENABLED_ENV] = 'true';
    const p = ports({
      match: { eventId, change: 'time', newStartsAt: NEW_START.toISOString(), newLocation: null },
    });
    adjust(p);
    return {
      result: await applyTeamScheduleChange(
        db.database,
        {
          familyId: family.familyId,
          parentUserId: family.parentUserId,
          integrationId,
          messageId: 'gmail-1',
          timeZone: TZ,
          now: NOW,
          classification: classified(),
          children: children(),
        },
        p,
      ),
      sent: p.transport instanceof FakeTransport ? p.transport.sent : [],
    };
  }

  async function onlyActionState() {
    const rows = await db.database
      .select({ id: schema.actions.id, state: schema.actions.userVisibleState })
      .from(schema.actions)
      .where(eq(schema.actions.familyId, family.familyId));
    expect(rows).toHaveLength(1);
    return rows[0] as { id: string; state: string };
  }

  const pending = () => defaultApprovalSpine().listPending(db.database, family.familyId);
  const quietHours = (p: TeamScheduleApplyPorts) => {
    p.gate = async () => ({ allowed: false, reason: 'quiet_hours' });
  };

  it('policy on: a quiet-hours hold leaves the yes list and the email notice takes over', async () => {
    vi.stubEnv('ASK_POLICY_TIERS_ENABLED', 'true');
    const eventId = await seedGame();
    const { result, sent } = await applyAsk(eventId, quietHours);
    expect(result).toEqual({ handled: false });
    expect(sent).toEqual([]);
    const action = await onlyActionState();
    expect(action.state).toBe('needs_human');
    expect(await pending()).toEqual([]);
    expect(await notRunRows()).toEqual([
      {
        audience: family.parentUserId,
        targetTable: 'users',
        targetId: family.parentUserId,
        after: { actionId: action.id, change: 'time' },
      },
    ]);
    expect(pages).toEqual([]);
  });

  it('policy on: a failed send leaves the yes list and stays the recorded outcome', async () => {
    vi.stubEnv('ASK_POLICY_TIERS_ENABLED', 'true');
    const eventId = await seedGame();
    const { result } = await applyAsk(eventId, (p) => {
      p.transport = new RefusingTransport();
    });
    expect(result).toEqual({ handled: true, outcome: 'send_failed' });
    expect((await onlyActionState()).state).toBe('needs_human');
    expect(await pending()).toEqual([]);
    expect(await notRunRows()).toHaveLength(1);
  });

  it('policy on: no number to text leaves the yes list', async () => {
    vi.stubEnv('ASK_POLICY_TIERS_ENABLED', 'true');
    const eventId = await seedGame();
    const { result, sent } = await applyAsk(eventId, (p) => {
      p.resolvePhone = async () => null;
    });
    expect(result).toEqual({ handled: true, outcome: 'no_send_target' });
    expect(sent).toEqual([]);
    expect((await onlyActionState()).state).toBe('needs_human');
    expect(await pending()).toEqual([]);
  });

  it('policy on: a draft that lost the send to an earlier text is not left on the yes list', async () => {
    vi.stubEnv('ASK_POLICY_TIERS_ENABLED', 'true');
    const eventId = await seedGame();
    const integrationId = randomUUID();
    await db.database.insert(schema.channelMessages).values({
      familyId: family.familyId,
      parentUserId: family.parentUserId,
      channel: 'sms',
      direction: 'out',
      category: 'email_alert',
      templateKey: 'team_schedule:parent',
      dedupeKey: `email_alert:${integrationId}:gmail-1`,
      status: 'sent',
    });
    const { result, sent } = await applyAsk(eventId, () => {}, integrationId);
    expect(result).toEqual({ handled: true, outcome: 'schedule_change_asked' });
    expect(sent).toEqual([]);
    expect((await onlyActionState()).state).toBe('needs_human');
    expect(await pending()).toEqual([]);
  });

  it('positive control, policy on: a delivered ask joins the yes list only once Linq took it', async () => {
    vi.stubEnv('ASK_POLICY_TIERS_ENABLED', 'true');
    const eventId = await seedGame();
    const atSend: string[] = [];
    const transport = new (class extends FakeTransport {
      override async send(input: Parameters<FakeTransport['send']>[0]) {
        atSend.push((await onlyActionState()).state);
        expect(await pending()).toEqual([]);
        return super.send(input);
      }
    })();
    const { result, sent } = await applyAsk(eventId, (p) => {
      p.transport = transport;
    });
    expect(result).toEqual({ handled: true, outcome: 'schedule_change_asked' });
    expect(sent).toHaveLength(1);
    expect(atSend).toEqual(['needs_human']);
    const action = await onlyActionState();
    expect(action.state).toBe('drafted_for_approval');
    expect((await pending()).map((row) => row.actionId)).toEqual([action.id]);
    expect(await notRunRows()).toEqual([]);
  });

  it('policy on: a send that throws before Linq took it leaves the draft off the yes list', async () => {
    vi.stubEnv('ASK_POLICY_TIERS_ENABLED', 'true');
    const eventId = await seedGame();
    const atSend: string[] = [];
    await expect(
      applyAsk(eventId, (p) => {
        p.gate = async () => {
          atSend.push((await onlyActionState()).state);
          throw new Error('gate store unavailable');
        };
      }),
    ).rejects.toThrow('gate store unavailable');
    expect(atSend).toEqual(['needs_human']);
    const action = await onlyActionState();
    expect(action.state).toBe('needs_human');
    expect(await pending()).toEqual([]);
    expect(await notRunRows()).toEqual([
      {
        audience: family.parentUserId,
        targetTable: 'users',
        targetId: family.parentUserId,
        after: { actionId: action.id, change: 'time' },
      },
    ]);
  });

  describe('a database error after Linq took the text', () => {
    const failLedger = () =>
      db.exec(`
        create or replace function fail_ledger_for_test() returns trigger as $$
        begin
          raise exception 'ledger write failed for test';
        end;
        $$ language plpgsql;
        create trigger fail_ledger_for_test before update on channel_messages
          for each row when (new.provider_message_id is not null)
          execute function fail_ledger_for_test();
      `);
    afterEach(async () => {
      await db.exec('drop trigger if exists fail_ledger_for_test on channel_messages;');
    });
    const ledgerRows = () =>
      db.database
        .select({
          status: schema.channelMessages.status,
          errorCode: schema.channelMessages.errorCode,
        })
        .from(schema.channelMessages)
        .where(eq(schema.channelMessages.familyId, family.familyId));

    it('policy on: it is not recorded as a failed send, and the asked draft can be approved', async () => {
      vi.stubEnv('ASK_POLICY_TIERS_ENABLED', 'true');
      const eventId = await seedGame();
      await failLedger();
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const { result, sent } = await applyAsk(eventId);
      expect(result).toEqual({ handled: true, outcome: 'schedule_change_asked' });
      expect(sent).toHaveLength(1);
      const rows = await ledgerRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.errorCode).toBeNull();
      expect(rows[0]?.status).not.toBe('failed');
      const action = await onlyActionState();
      expect(action.state).toBe('drafted_for_approval');
      expect((await pending()).map((row) => row.actionId)).toEqual([action.id]);
      expect(await notRunRows()).toEqual([]);
    });

    it('policy off: it ends as a failed send, as today', async () => {
      vi.stubEnv('ASK_POLICY_TIERS_ENABLED', 'false');
      const eventId = await seedGame();
      await failLedger();
      const { result } = await applyAsk(eventId);
      expect(result).toEqual({ handled: true, outcome: 'send_failed' });
      expect((await ledgerRows())[0]?.status).toBe('failed');
      expect((await onlyActionState()).state).toBe('drafted_for_approval');
    });
  });

  describe('the draft cannot join the yes list after Linq took the ask', () => {
    const failPromotion = () =>
      db.exec(`
        create or replace function fail_promotion_for_test() returns trigger as $$
        begin
          raise exception 'promotion failed for test';
        end;
        $$ language plpgsql;
        create trigger fail_promotion_for_test before update on actions
          for each row when (new.user_visible_state = 'drafted_for_approval')
          execute function fail_promotion_for_test();
      `);
    afterEach(async () => {
      await db.exec('drop trigger if exists fail_promotion_for_test on actions;');
    });

    it('policy on: the ledger and thread are written, the draft stays off the yes list, and #ops hears', async () => {
      vi.stubEnv('ASK_POLICY_TIERS_ENABLED', 'true');
      const eventId = await seedGame();
      await failPromotion();
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const threaded: string[] = [];
      const { result, sent } = await applyAsk(eventId, (p) => {
        p.threadMessage = async (_database, message) => {
          threaded.push(message.body);
          return 'conv-1';
        };
      });

      expect(result).toEqual({ handled: true, outcome: 'schedule_change_asked' });
      expect(sent).toHaveLength(1);
      const ledger = await db.database
        .select({
          providerMessageId: schema.channelMessages.providerMessageId,
          status: schema.channelMessages.status,
        })
        .from(schema.channelMessages)
        .where(eq(schema.channelMessages.familyId, family.familyId));
      expect(ledger).toHaveLength(1);
      expect(ledger[0]?.providerMessageId).toBe('fake-out-1');
      expect(ledger[0]?.status).not.toBe('failed');
      expect(threaded).toHaveLength(1);
      const action = await onlyActionState();
      expect(action.state).toBe('needs_human');
      expect(await pending()).toEqual([]);
      expect(await notRunRows()).toEqual([
        {
          audience: family.parentUserId,
          targetTable: 'users',
          targetId: family.parentUserId,
          after: { actionId: action.id, change: 'time' },
        },
      ]);
      expect(pages).toEqual([
        { site: 'team_schedule_ask_unbound', facts: { change: 'time' }, ref: action.id },
      ]);
    });

    it('control, policy on: a promotion that lands pages no one and writes no not-run row', async () => {
      vi.stubEnv('ASK_POLICY_TIERS_ENABLED', 'true');
      const eventId = await seedGame();
      const { result } = await applyAsk(eventId);
      expect(result).toEqual({ handled: true, outcome: 'schedule_change_asked' });
      expect((await onlyActionState()).state).toBe('drafted_for_approval');
      expect(await notRunRows()).toEqual([]);
      expect(pages).toEqual([]);
    });
  });

  it('the real mint writes a held draft off the yes list from its first row', async () => {
    const failingReviewer = {} as Parameters<typeof mintChannelCalendarDraft>[2];
    const mint = (heldUntilAsked: boolean) =>
      mintChannelCalendarDraft(
        {
          familyId: family.familyId,
          actor: 'system',
          origin: { surface: 'private' },
          actionType: 'calendar_move',
          payload: { title: 'Game', startsAt: NEW_START.toISOString(), endsAt: null },
          rationale: 'test',
          teenContent: false,
          heldUntilAsked,
        },
        db.database,
        failingReviewer,
        NOW,
      ).catch(() => null);
    await mint(true);
    expect((await onlyActionState()).state).toBe('needs_human');
    await db.database.delete(schema.actions).where(eq(schema.actions.familyId, family.familyId));
    await mint(false);
    expect((await onlyActionState()).state).toBe('drafted_for_approval');
  });

  it('policy off: the draft is on the yes list while the text is sent, as today', async () => {
    vi.stubEnv('ASK_POLICY_TIERS_ENABLED', 'false');
    const eventId = await seedGame();
    const atSend: string[] = [];
    const transport = new (class extends FakeTransport {
      override async send(input: Parameters<FakeTransport['send']>[0]) {
        atSend.push((await onlyActionState()).state);
        return super.send(input);
      }
    })();
    await applyAsk(eventId, (p) => {
      p.transport = transport;
    });
    expect(atSend).toEqual(['drafted_for_approval']);
  });

  it('policy off: a quiet-hours hold ends as it does today', async () => {
    vi.stubEnv('ASK_POLICY_TIERS_ENABLED', 'false');
    const eventId = await seedGame();
    const { result } = await applyAsk(eventId, quietHours);
    expect(result).toEqual({ handled: true, outcome: 'gate_refused:quiet_hours' });
    expect((await onlyActionState()).state).toBe('drafted_for_approval');
    expect(await pending()).toHaveLength(1);
    expect(await notRunRows()).toEqual([]);
  });

  it('policy off: a failed send ends as it does today', async () => {
    vi.stubEnv('ASK_POLICY_TIERS_ENABLED', 'false');
    const eventId = await seedGame();
    const { result } = await applyAsk(eventId, (p) => {
      p.transport = new RefusingTransport();
    });
    expect(result).toEqual({ handled: true, outcome: 'send_failed' });
    expect((await onlyActionState()).state).toBe('drafted_for_approval');
    expect(await notRunRows()).toEqual([]);
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

  async function applyUnderGrant(eventId: string, executes: boolean, executionFails = false) {
    process.env[TEAM_SCHEDULE_CHANGES_ENABLED_ENV] = 'true';
    const p = ports({
      match: { eventId, change: 'time', newStartsAt: NEW_START.toISOString(), newLocation: null },
      parentText: 'Leo’s hockey moved to 2.',
      autonomous: true,
      executes,
      executionFails,
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

  async function actionRows() {
    return db.database
      .select({
        id: schema.actions.id,
        state: schema.actions.userVisibleState,
        executedAt: schema.actions.executedAt,
      })
      .from(schema.actions)
      .where(eq(schema.actions.familyId, family.familyId));
  }

  it('policy on: a refused change leaves the yes list and the email notice takes over', async () => {
    vi.stubEnv('ASK_POLICY_TIERS_ENABLED', 'true');
    const eventId = await seedGame({ dutyOwnerUserId: family.parentUserId });
    const reminderId = await seedReminder(eventId);
    const { result, sent } = await applyUnderGrant(eventId, false);
    expect(result).toEqual({ handled: false });
    expect(sent).toEqual([]);
    expect(pages).toEqual([]);
    expect(await reminderFireAt(reminderId)).toBe(REMINDER_AT.toISOString());
    expect(await effectsStamp()).toEqual([null]);
    const [action] = await actionRows();
    expect(action?.state).toBe('needs_human');
    expect(action?.executedAt).toBeNull();
    expect(await notRunRows()).toEqual([
      {
        audience: family.parentUserId,
        targetTable: 'users',
        targetId: family.parentUserId,
        after: { actionId: action?.id, change: 'time' },
      },
    ]);
    expect(await defaultApprovalSpine().listPending(db.database, family.familyId)).toEqual([]);
  });

  describe('the not-run row belongs to the parent whose inbox it came from', () => {
    const NOT_RUN = 'Hale did not make a schedule change from an email';

    async function seedCoParent(): Promise<string> {
      const [co] = await db.database
        .insert(schema.users)
        .values({ email: `${family.familyId}-co@example.test`, name: 'Co Parent' })
        .returning({ id: schema.users.id });
      await db.database
        .insert(schema.familyMembers)
        .values({ familyId: family.familyId, userId: co?.id as string, role: 'co_parent' });
      return co?.id as string;
    }

    const history = async (viewerUserId: string) =>
      (await loadTrailForFamily(db.database, family.familyId, undefined, { viewerUserId })).map(
        (row) => row.summary,
      );
    const exported = async (actorUserId: string) =>
      (
        await assembleFamilyExport(db.database, family.familyId, { actorUserId, now: NOW })
      ).trail.map((row) => row.summary);

    it('audience lit: only the receiving parent sees it, in History and the export', async () => {
      vi.stubEnv('ASK_POLICY_TIERS_ENABLED', 'true');
      vi.stubEnv(AUDIT_LOG_AUDIENCE_ENABLED_ENV, 'true');
      const coParent = await seedCoParent();
      await applyUnderGrant(await seedGame(), false);
      expect(await history(family.parentUserId)).toContain(NOT_RUN);
      expect(await exported(family.parentUserId)).toContain(NOT_RUN);
      expect(await history(coParent)).not.toContain(NOT_RUN);
      expect(await exported(coParent)).not.toContain(NOT_RUN);
    });

    it('audience unlit: off both Histories, and only in the receiving parent’s own export', async () => {
      vi.stubEnv('ASK_POLICY_TIERS_ENABLED', 'true');
      const coParent = await seedCoParent();
      await applyUnderGrant(await seedGame(), false);
      expect(await exported(family.parentUserId)).toContain(NOT_RUN);
      expect(await exported(coParent)).not.toContain(NOT_RUN);
      expect(await history(family.parentUserId)).not.toContain(NOT_RUN);
      expect(await history(coParent)).not.toContain(NOT_RUN);
    });
  });

  it('policy on: a failed run pages #ops and the email notice takes over', async () => {
    vi.stubEnv('ASK_POLICY_TIERS_ENABLED', 'true');
    const eventId = await seedGame({ dutyOwnerUserId: family.parentUserId });
    const reminderId = await seedReminder(eventId);
    const { result, sent } = await applyUnderGrant(eventId, true, true);
    expect(result).toEqual({ handled: false });
    expect(sent).toEqual([]);
    const [action] = await actionRows();
    expect(pages).toEqual([
      { site: 'team_schedule_not_applied', facts: { change: 'time' }, ref: action?.id },
    ]);
    expect(action?.state).toBe('needs_human');
    expect(action?.executedAt).not.toBeNull();
    expect(await reminderFireAt(reminderId)).toBe(REMINDER_AT.toISOString());
    expect(await effectsStamp()).toEqual([null]);
    expect(await defaultApprovalSpine().listPending(db.database, family.familyId)).toEqual([]);
  });

  it('policy on: an executor that throws is a failed run, paged and off the yes list', async () => {
    vi.stubEnv('ASK_POLICY_TIERS_ENABLED', 'true');
    process.env[TEAM_SCHEDULE_CHANGES_ENABLED_ENV] = 'true';
    const eventId = await seedGame({ dutyOwnerUserId: family.parentUserId });
    const p = ports({
      match: { eventId, change: 'time', newStartsAt: NEW_START.toISOString(), newLocation: null },
      parentText: 'Leo’s hockey moved to 2.',
      autonomous: true,
    });
    p.execute = async () => {
      throw new Error('executor unavailable');
    };
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
    expect(result).toEqual({ handled: false });
    expect((p.transport as FakeTransport).sent).toEqual([]);
    const [action] = await actionRows();
    expect(pages).toEqual([
      { site: 'team_schedule_not_applied', facts: { change: 'time' }, ref: action?.id },
    ]);
    expect(action?.state).toBe('needs_human');
    expect(await defaultApprovalSpine().listPending(db.database, family.familyId)).toEqual([]);
  });

  it('policy off: an executor that throws still throws, as today', async () => {
    vi.stubEnv('ASK_POLICY_TIERS_ENABLED', 'false');
    process.env[TEAM_SCHEDULE_CHANGES_ENABLED_ENV] = 'true';
    const eventId = await seedGame({ dutyOwnerUserId: family.parentUserId });
    const p = ports({
      match: { eventId, change: 'time', newStartsAt: NEW_START.toISOString(), newLocation: null },
      parentText: 'Leo’s hockey moved to 2.',
      autonomous: true,
    });
    p.execute = async () => {
      throw new Error('executor unavailable');
    };
    await expect(
      applyTeamScheduleChange(
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
      ),
    ).rejects.toThrow('executor unavailable');
    expect(pages).toEqual([]);
  });

  it('policy off: a failed run ends as it does today, handled with no page', async () => {
    vi.stubEnv('ASK_POLICY_TIERS_ENABLED', 'false');
    const eventId = await seedGame({ dutyOwnerUserId: family.parentUserId });
    const { result } = await applyUnderGrant(eventId, true, true);
    expect(result).toEqual({ handled: true, outcome: 'schedule_change_applied' });
    expect(pages).toEqual([]);
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

describe('VIL-719 a driver outside the family’s own parents', () => {
  const match = (eventId: string): ScheduleMatch => ({
    eventId,
    change: 'time',
    newStartsAt: NEW_START.toISOString(),
    newLocation: null,
  });

  function grantPorts(eventId: string) {
    process.env[TEAM_SCHEDULE_CHANGES_ENABLED_ENV] = 'true';
    const p = ports({ match: match(eventId), parentText: 'Leo’s hockey moved.', autonomous: true });
    const modes: string[] = [];
    const compose = p.composeParent;
    p.composeParent = async (input) => {
      modes.push(input.mode);
      return compose(input);
    };
    const execute = vi.fn(p.execute);
    p.execute = execute;
    const composedFor: string[] = [];
    p.driver.composeDriver = async (input) => {
      composedFor.push(input.userId);
      return 'Pickup moved to 2.';
    };
    return { p, modes, execute, composedFor };
  }

  const apply = (p: TeamScheduleApplyPorts) =>
    applyTeamScheduleChange(
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

  async function caregiverInFamily(): Promise<string> {
    const [user] = await db.database
      .insert(schema.users)
      .values({ externalAuthId: `sms:sitter-${randomUUID()}`, name: 'Sitter' })
      .returning({ id: schema.users.id });
    const userId = user?.id as string;
    await db.database
      .insert(schema.familyMembers)
      .values({ familyId: family.familyId, userId, role: 'grandparent' });
    return userId;
  }

  it('policy on: another family’s driver holds the change for the parent’s yes', async () => {
    vi.stubEnv('ASK_POLICY_TIERS_ENABLED', 'true');
    vi.stubEnv('TEAM_SCHEDULE_SEND_RECEIPT_ENABLED', 'false');
    const other = await seedFamily(db.database, 'Other family');
    const eventId = await seedGame({ dutyOwnerUserId: other.parentUserId });
    const { p, modes, execute, composedFor } = grantPorts(eventId);

    const result = await apply(p);

    expect(result).toEqual({ handled: true, outcome: 'schedule_change_asked' });
    expect(modes).toEqual(['ask']);
    expect(execute).not.toHaveBeenCalled();
    expect(composedFor).toEqual([]);
    const [action] = await db.database
      .select({ id: schema.actions.id, state: schema.actions.userVisibleState })
      .from(schema.actions)
      .where(eq(schema.actions.familyId, family.familyId));
    expect(action?.state).toBe('drafted_for_approval');

    await markExecuted(action?.id as string);
    await applyTeamScheduleEffects(
      db.database,
      { actionId: action?.id as string, familyId: family.familyId, now: NOW },
      p.driver,
    );
    expect(composedFor).toEqual([other.parentUserId]);
  });

  it('policy on: a caregiver who is not a parent is held the same way', async () => {
    vi.stubEnv('ASK_POLICY_TIERS_ENABLED', 'true');
    const caregiver = await caregiverInFamily();
    const eventId = await seedGame({ dutyOwnerUserId: caregiver });
    const { p, modes, execute, composedFor } = grantPorts(eventId);

    expect(await apply(p)).toEqual({ handled: true, outcome: 'schedule_change_asked' });
    expect(modes).toEqual(['ask']);
    expect(execute).not.toHaveBeenCalled();
    expect(composedFor).toEqual([]);
  });

  it('positive control, policy on: the family’s own parent is told under the grant', async () => {
    vi.stubEnv('ASK_POLICY_TIERS_ENABLED', 'true');
    const eventId = await seedGame({ dutyOwnerUserId: family.parentUserId });
    const { p, modes, execute, composedFor } = grantPorts(eventId);

    expect(await apply(p)).toEqual({ handled: true, outcome: 'schedule_change_applied' });
    expect(modes).toEqual(['applied']);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(composedFor).toEqual([family.parentUserId]);
  });

  it('policy on: a driver swapped in after the check is not texted under the grant', async () => {
    vi.stubEnv('ASK_POLICY_TIERS_ENABLED', 'true');
    const other = await seedFamily(db.database, 'Other family');
    const eventId = await seedGame({ dutyOwnerUserId: family.parentUserId });
    const { p, composedFor } = grantPorts(eventId);
    const compose = p.composeParent;
    p.composeParent = async (input) => {
      await db.database
        .update(schema.familyEvents)
        .set({ dutyOwnerUserId: other.parentUserId })
        .where(eq(schema.familyEvents.id, eventId));
      return compose(input);
    };

    expect(await apply(p)).toEqual({ handled: true, outcome: 'schedule_change_applied' });
    expect(composedFor).toEqual([]);
  });

  it('policy off: another family’s driver is texted under the grant, as today', async () => {
    vi.stubEnv('ASK_POLICY_TIERS_ENABLED', 'false');
    vi.stubEnv('TEAM_SCHEDULE_SEND_RECEIPT_ENABLED', 'false');
    const other = await seedFamily(db.database, 'Other family');
    const eventId = await seedGame({ dutyOwnerUserId: other.parentUserId });
    const { p, modes, composedFor } = grantPorts(eventId);

    expect(await apply(p)).toEqual({ handled: true, outcome: 'schedule_change_applied' });
    expect(modes).toEqual(['applied']);
    expect(composedFor).toEqual([other.parentUserId]);
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
