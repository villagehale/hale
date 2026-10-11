import type { AgentClient } from '@hale/agent';
import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type TestDb, createTestDb, seedFamily, seedIntegration } from '~/lib/testing/pglite';
import { runKidRelevanceBackfill } from './backfill';
import { KID_VERDICT_TOOL, type KidSkillInput } from './skill-contract';

/**
 * The one-off backfill (VIL-226 item 5, founder defaults D9/D10). Existing connector
 * copies are judged; adult ones leave the family calendar with their reminders cancelled
 * under a named reason and an audit row; an adult parent block loses its kid flag and
 * title; adult bookings are only counted. A dry run changes no tracking state. The model
 * is a scripted fake at the client port - the skill's quality is the eval. Every title
 * here is invented.
 */

let db: TestDb;
const INPUT_KEY = Buffer.alloc(32, 7).toString('base64');
const NOW = new Date('2026-10-11T15:00:00.000Z');
const NEXT_WEEK = new Date('2026-10-18T15:00:00.000Z');
const NO_DEADLINE = new Date('2099-01-01T00:00:00.000Z');

let familyId: string;
let parentUserId: string;
let gcal: string;
let gmail: string;
let modelCalls: number;

const ADULT = ['Standup', 'Dentist', 'Team dinner', 'Harbour Inn', 'Pottery for grown-ups'];
const UNSURE = ['Mystery meetup'];

function scriptedVerdict(text: string) {
  if (ADULT.some((title) => text.includes(title))) return 'adult';
  if (UNSURE.some((title) => text.includes(title))) return 'unsure';
  return 'kid';
}

const client = {
  messages: {
    create: async (request: { messages: { content: string }[] }) => {
      modelCalls += 1;
      const input = JSON.parse(request.messages[0]?.content ?? '{}') as KidSkillInput;
      return {
        content: [
          {
            type: 'tool_use',
            id: 't',
            name: KID_VERDICT_TOOL,
            input: {
              verdicts: input.items.map((item) => ({
                ref: item.ref,
                reason: 'scripted',
                verdict: scriptedVerdict(item.text),
                childName: null,
              })),
            },
          },
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    },
  },
} as unknown as AgentClient;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  process.env.APP_ENCRYPTION_KEY = INPUT_KEY;
  process.env.HALE_LLM_NO_STREAM = '1';
  modelCalls = 0;
  const family = await seedFamily(db.database);
  familyId = family.familyId;
  parentUserId = family.parentUserId;
  gcal = await seedIntegration(db.database, familyId, parentUserId, 'gcal');
  gmail = await seedIntegration(db.database, familyId, parentUserId, 'gmail');
});

async function mirror(googleEventId: string, title: string) {
  const [row] = await db.database
    .insert(schema.familyEvents)
    .values({
      familyId,
      title,
      startsAt: NEXT_WEEK,
      location: 'Community hall',
      source: 'parent',
      createdBy: parentUserId,
      googleEventId,
      integrationId: gcal,
    })
    .returning({ id: schema.familyEvents.id });
  if (!row) throw new Error('no mirror');
  await db.database.insert(schema.eventReminders).values([
    { familyId, eventRef: row.id, parentUserId, offset: '-P1D', fireAt: NEXT_WEEK },
    { familyId, eventRef: row.id, parentUserId, offset: '-PT1H', fireAt: NEXT_WEEK },
  ]);
  return row.id;
}

async function acceptedOffer(messageId: string, title: string) {
  const [event] = await db.database
    .insert(schema.familyEvents)
    .values({ familyId, title, startsAt: NEXT_WEEK, source: 'parent' })
    .returning({ id: schema.familyEvents.id });
  const [message] = await db.database
    .insert(schema.channelMessages)
    .values({
      familyId,
      parentUserId,
      channel: 'sms',
      direction: 'out',
      category: 'alert',
      status: 'sent',
      sentAt: NOW,
    })
    .returning({ id: schema.channelMessages.id });
  await db.database.insert(schema.emailAlertOffers).values({
    familyId,
    parentUserId,
    integrationId: gmail,
    messageId,
    kind: 'event',
    title,
    startsAt: NEXT_WEEK,
    channelMessageId: message?.id ?? '',
    expiresAt: NEXT_WEEK,
    eventId: event?.id,
    resolvedAt: NOW,
    resolution: 'added',
    resolvedChannelMessageId: message?.id ?? '',
  });
  return event?.id ?? '';
}

async function seed() {
  const adultA = await mirror('ev-standup', 'Standup');
  const adultB = await mirror('ev-dentist', 'Dentist');
  const kid = await mirror('ev-swim', 'Wren swim');
  const offer = await acceptedOffer('msg-dinner', 'Team dinner');
  await db.database.insert(schema.parentCalendarBlocks).values({
    integrationId: gcal,
    eventId: 'ev-pottery',
    familyId,
    userId: parentUserId,
    startAt: NEXT_WEEK,
    kidRelated: true,
    title: 'Pottery for grown-ups',
    status: 'confirmed',
    updatedStamp: 'u1',
  });
  await db.database.insert(schema.activityBookings).values({
    familyId,
    parentUserId,
    integrationId: gmail,
    messageId: 'msg-hotel',
    providerHost: 'example.test',
    title: 'Harbour Inn',
    firstSessionAt: NEXT_WEEK,
  });
  return { adultA, adultB, kid, offer };
}

async function state() {
  const events = await db.database
    .select()
    .from(schema.familyEvents)
    .where(eq(schema.familyEvents.familyId, familyId));
  const reminders = await db.database
    .select()
    .from(schema.eventReminders)
    .where(eq(schema.eventReminders.familyId, familyId));
  const blocks = await db.database
    .select()
    .from(schema.parentCalendarBlocks)
    .where(eq(schema.parentCalendarBlocks.familyId, familyId));
  const bookings = await db.database
    .select()
    .from(schema.activityBookings)
    .where(eq(schema.activityBookings.familyId, familyId));
  const audit = await db.database
    .select()
    .from(schema.auditLog)
    .where(eq(schema.auditLog.familyId, familyId));
  return { events, reminders, blocks, bookings, audit };
}

function run(apply: boolean) {
  return runKidRelevanceBackfill(
    db.database,
    { apply, now: NOW, deadline: NO_DEADLINE, familyIds: [familyId] },
    { client },
  );
}

describe('runKidRelevanceBackfill', () => {
  it('a dry run counts what it would do and changes no tracking state', async () => {
    await seed();
    const before = await state();

    const counts = await run(false);

    expect(counts).toEqual({
      apply: false,
      families: 1,
      judged: 6,
      kid: 1,
      adult: 5,
      unsure: 0,
      held: 0,
      eventsDropped: 3,
      remindersCancelled: 4,
      blocksCleared: 1,
      adultBookings: 1,
    });
    expect(await state()).toEqual(before);
  });

  it('apply drops adult copies, cancels their reminders with the reason and audits each', async () => {
    const ids = await seed();

    const counts = await run(true);
    expect(counts).toMatchObject({ apply: true, eventsDropped: 3, remindersCancelled: 4 });

    const after = await state();
    const event = (id: string) => after.events.find((row) => row.id === id);
    expect(event(ids.adultA)?.deletedAt).toEqual(NOW);
    expect(event(ids.adultB)?.deletedAt).toEqual(NOW);
    expect(event(ids.offer)?.deletedAt).toEqual(NOW);
    for (const id of [ids.adultA, ids.adultB, ids.offer]) {
      expect(event(id)).toMatchObject({ title: '', location: null, dutyOwnerLabel: null });
    }

    const kid = event(ids.kid);
    expect(kid?.deletedAt).toBeNull();
    expect(kid?.title).toBe('Wren swim');
    expect(kid?.location).toBe('Community hall');
    expect(kid?.kidVerdictId).not.toBeNull();
    const kidReminders = after.reminders.filter((row) => row.eventRef === ids.kid);
    expect(kidReminders.map((row) => row.status)).toEqual(['scheduled', 'scheduled']);

    const dropped = after.reminders.filter((row) => row.eventRef !== ids.kid);
    expect(dropped).toHaveLength(4);
    expect(new Set(dropped.map((row) => `${row.status}/${row.suppressReason}`))).toEqual(
      new Set(['cancelled/kid_relevance_backfill']),
    );

    const verbs = after.audit.map((row) => row.actionTaken).sort();
    expect(verbs).toEqual([
      'kid_relevance_event_dropped',
      'kid_relevance_event_dropped',
      'kid_relevance_event_dropped',
      'kid_relevance_event_dropped',
      'kid_relevance_reminder_cancelled',
      'kid_relevance_reminder_cancelled',
      'kid_relevance_reminder_cancelled',
      'kid_relevance_reminder_cancelled',
    ]);
    const cancelAudit = after.audit.find(
      (row) => row.actionTaken === 'kid_relevance_reminder_cancelled',
    );
    expect(cancelAudit).toMatchObject({
      actor: 'system',
      targetTable: 'event_reminders',
      after: { reason: 'kid_relevance_backfill' },
    });
    const dropAudits = after.audit.filter(
      (row) => row.actionTaken === 'kid_relevance_event_dropped',
    );
    expect(
      dropAudits
        .map((row) => {
          const payload = row.after as { verdict: string; source: string };
          return `${row.targetTable}/${payload.verdict}/${payload.source}`;
        })
        .sort(),
    ).toEqual([
      'family_events/adult/gmail',
      'family_events/adult/google_calendar',
      'family_events/adult/google_calendar',
      'parent_calendar_blocks/adult/google_calendar',
    ]);
    const serialized = JSON.stringify(after.audit);
    for (const title of ADULT) expect(serialized).not.toContain(title);

    expect(after.blocks).toEqual([
      expect.objectContaining({ eventId: 'ev-pottery', kidRelated: false, title: null }),
    ]);
    expect(after.bookings).toEqual([
      expect.objectContaining({ title: 'Harbour Inn', cancelledAt: null, eventId: null }),
    ]);
  });

  it('apply leaves an unsure copy alone: live, unlinked, its reminders still scheduled', async () => {
    const unsure = await mirror('ev-mystery', 'Mystery meetup');
    const counts = await run(true);
    expect(counts).toMatchObject({ unsure: 1, eventsDropped: 0, remindersCancelled: 0 });
    const after = await state();
    const event = after.events.find((row) => row.id === unsure);
    expect(event).toMatchObject({ deletedAt: null, kidVerdictId: null });
    expect(after.reminders.map((row) => row.status)).toEqual(['scheduled', 'scheduled']);
    expect(after.audit).toEqual([]);
  });

  it('a second apply reuses the verdicts and changes nothing more', async () => {
    await seed();
    await run(true);
    const calls = modelCalls;
    const before = await state();

    const counts = await run(true);

    expect(modelCalls).toBe(calls);
    expect(counts).toMatchObject({ eventsDropped: 0, remindersCancelled: 0, blocksCleared: 0 });
    expect(await state()).toEqual(before);
  });
});
