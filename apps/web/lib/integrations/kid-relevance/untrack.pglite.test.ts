import type { AgentClient } from '@hale/agent';
import { schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  calendarAlertDedupeKey,
  calendarSeriesAlertDedupeKey,
} from '~/lib/integrations/calendar-alert';
import { emailAlertDedupeKey } from '~/lib/integrations/email-alert';
import { type TestDb, createTestDb, seedFamily, seedIntegration } from '~/lib/testing/pglite';
import { judgeKidRelevance, loadNotMineHints } from './judge';
import { KID_VERDICT_TOOL } from './skill-contract';
import { untrackItem } from './untrack';

/**
 * "That's mine." The parent's word becomes an `adult` verdict for the whole series, the
 * future copies leave the family calendar, their reminders are cancelled with a named
 * reason, the kind is remembered as a hint for the judge, and one audit row records it
 * with counts and no title. Every title here is invented.
 */

let db: TestDb;
const INPUT_KEY = Buffer.alloc(32, 7).toString('base64');
const NOW = new Date('2026-10-11T15:00:00.000Z');
const PAST = new Date('2026-10-04T15:00:00.000Z');
const NEXT_WEEK = new Date('2026-10-18T15:00:00.000Z');
const WEEK_AFTER = new Date('2026-10-25T15:00:00.000Z');

let familyId: string;
let parentUserId: string;
let integrationId: string;
let gmailIntegrationId: string;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  process.env.APP_ENCRYPTION_KEY = INPUT_KEY;
  const family = await seedFamily(db.database);
  familyId = family.familyId;
  parentUserId = family.parentUserId;
  integrationId = await seedIntegration(db.database, familyId, parentUserId, 'gcal');
  gmailIntegrationId = await seedIntegration(db.database, familyId, parentUserId, 'gmail');
});

async function snapshot(eventId: string, recurringEventId: string | null) {
  await db.database.insert(schema.calendarEventSnapshots).values({
    integrationId,
    eventId,
    recurringEventId,
    updatedStamp: 'u1',
    status: 'confirmed',
  });
}

async function mirror(googleEventId: string, startsAt: Date, title = 'Choir rehearsal') {
  const [row] = await db.database
    .insert(schema.familyEvents)
    .values({
      familyId,
      title,
      startsAt,
      location: 'Community hall',
      source: 'parent',
      createdBy: parentUserId,
      googleEventId,
      integrationId,
    })
    .returning({ id: schema.familyEvents.id });
  if (!row) throw new Error('no mirror row');
  await db.database.insert(schema.eventReminders).values([
    { familyId, eventRef: row.id, parentUserId, offset: '-P1D', fireAt: startsAt },
    { familyId, eventRef: row.id, parentUserId, offset: '-PT1H', fireAt: startsAt },
  ]);
  return row.id;
}

async function alertMessage(dedupeKey: string | null) {
  const [row] = await db.database
    .insert(schema.channelMessages)
    .values({
      familyId,
      parentUserId,
      channel: 'sms',
      direction: 'out',
      category: 'alert',
      dedupeKey,
      status: 'sent',
      sentAt: NOW,
    })
    .returning({ id: schema.channelMessages.id });
  if (!row) throw new Error('no message row');
  return row.id;
}

function untrack(
  target: { kind: 'channel_message' | 'family_event'; id: string },
  kind = 'a choir',
) {
  return untrackItem(db.database, { familyId, actorUserId: parentUserId, target, now: NOW, kind });
}

async function liveEvents() {
  const rows = await db.database
    .select()
    .from(schema.familyEvents)
    .where(eq(schema.familyEvents.familyId, familyId));
  return rows.filter((row) => row.deletedAt === null).map((row) => row.googleEventId);
}

async function memoryFacts() {
  return db.database
    .select()
    .from(schema.familyMemoryFacts)
    .where(eq(schema.familyMemoryFacts.familyId, familyId));
}

async function parentVerdicts() {
  return db.database
    .select()
    .from(schema.kidRelevanceVerdicts)
    .where(
      and(
        eq(schema.kidRelevanceVerdicts.familyId, familyId),
        eq(schema.kidRelevanceVerdicts.decidedBy, 'parent'),
      ),
    );
}

async function reminders() {
  return db.database
    .select()
    .from(schema.eventReminders)
    .where(eq(schema.eventReminders.familyId, familyId));
}

describe('untrackItem', () => {
  it('turns an instance alert into a parent adult verdict for its whole series', async () => {
    await snapshot('choir_1018', 'choir-series');
    await snapshot('choir_1025', 'choir-series');
    await snapshot('choir_1004', 'choir-series');
    await mirror('choir_1018', NEXT_WEEK);
    await mirror('choir_1025', WEEK_AFTER);
    await mirror('choir_1004', PAST);
    await mirror('unrelated', NEXT_WEEK, 'Wren swim');
    const message = await alertMessage(calendarAlertDedupeKey(integrationId, 'choir_1018', 'u1'));

    const result = await untrack({ kind: 'channel_message', id: message });

    expect(result).toEqual({
      outcome: 'untracked',
      seenIn: 'google_calendar',
      cancelledReminders: 4,
      removedEvents: 2,
    });
    expect((await liveEvents()).sort()).toEqual(['choir_1004', 'unrelated']);
    const events = await db.database
      .select()
      .from(schema.familyEvents)
      .where(eq(schema.familyEvents.familyId, familyId));
    const removed = events.filter((row) => row.deletedAt !== null);
    expect(removed.map((row) => [row.googleEventId, row.title, row.location]).sort()).toEqual([
      ['choir_1018', '', null],
      ['choir_1025', '', null],
    ]);
    const kid = events.find((row) => row.googleEventId === 'unrelated');
    expect(kid).toMatchObject({ deletedAt: null, title: 'Wren swim', location: 'Community hall' });
    expect(
      (await reminders()).filter((row) => row.eventRef === kid?.id).map((row) => row.status),
    ).toEqual(['scheduled', 'scheduled']);

    const [verdict] = await db.database
      .select()
      .from(schema.kidRelevanceVerdicts)
      .where(eq(schema.kidRelevanceVerdicts.familyId, familyId));
    expect(verdict).toMatchObject({
      source: 'google_calendar',
      integrationId,
      itemKey: 'choir-series',
      verdict: 'adult',
      decidedBy: 'parent',
      reason: null,
    });

    const cancelled = (await reminders()).filter((row) => row.status === 'cancelled');
    expect(cancelled).toHaveLength(4);
    expect(new Set(cancelled.map((row) => row.suppressReason))).toEqual(
      new Set(['parent_untracked']),
    );
    expect((await reminders()).filter((row) => row.status === 'scheduled')).toHaveLength(4);
  });

  it('writes one audit row with the verdict, source and counts and no title', async () => {
    await snapshot('choir_1018', 'choir-series');
    await mirror('choir_1018', NEXT_WEEK);
    const message = await alertMessage(
      calendarSeriesAlertDedupeKey(integrationId, 'choir-series', 'live', 'u1'),
    );

    await untrack({ kind: 'channel_message', id: message });

    const audit = await db.database
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.familyId, familyId));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actor: parentUserId,
      actionTaken: 'kid_relevance_untracked',
      targetTable: 'kid_relevance_verdicts',
      after: {
        verdict: 'adult',
        source: 'google_calendar',
        cancelledReminders: 2,
        removedEvents: 1,
      },
    });
    expect(JSON.stringify(audit[0])).not.toContain('Choir');
  });

  it('keeps the kind on the parent verdict as the hint the judge reads, and never the title', async () => {
    const factsBefore = await memoryFacts();
    const event = await mirror('one-off', NEXT_WEEK, 'Harbour Inn check-in');
    await untrack({ kind: 'family_event', id: event }, 'a hotel stay');
    expect(await loadNotMineHints(db.database, familyId)).toEqual(['a hotel stay']);

    const second = await mirror('another', NEXT_WEEK, 'Dentist cleaning');
    await untrack({ kind: 'family_event', id: second }, 'Dentist cleaning');
    expect(await loadNotMineHints(db.database, familyId)).toEqual(['a hotel stay']);

    const verdicts = await parentVerdicts();
    expect(verdicts.map((row) => [row.itemKey, row.hint]).sort()).toEqual([
      ['another', null],
      ['one-off', 'a hotel stay'],
    ]);
    expect(JSON.stringify(verdicts)).not.toContain('Dentist');
    // No family memory fact: those reach the coach, the digest and the co-parent.
    expect(await memoryFacts()).toEqual(factsBefore);
  });

  it('keeps a hint to one plain line of a few words', async () => {
    const first = await mirror('one-off', NEXT_WEEK, 'Harbour Inn check-in');
    await untrack({ kind: 'family_event', id: first }, 'a hotel\nstay\u0007');
    const second = await mirror('another', NEXT_WEEK, 'Quarterly review');
    await untrack({ kind: 'family_event', id: second }, `a work thing ${'with detail '.repeat(10)}`);
    expect((await parentVerdicts()).map((row) => [row.itemKey, row.hint]).sort()).toEqual([
      ['another', null],
      ['one-off', 'a hotel stay'],
    ]);
  });

  it('refuses a kind that repeats the title Hale saw, even with no calendar copy', async () => {
    await db.database.insert(schema.calendarEventSnapshots).values({
      integrationId,
      eventId: 'yoga_1018',
      recurringEventId: 'yoga-series',
      updatedStamp: 'u1',
      status: 'confirmed',
      startAt: NEXT_WEEK,
      pendingSince: NOW,
      heldTitle: 'Sunrise yoga',
    });
    const message = await alertMessage(calendarAlertDedupeKey(integrationId, 'yoga_1018', 'u1'));
    await untrack({ kind: 'channel_message', id: message }, 'sunrise yoga');
    expect((await parentVerdicts()).map((row) => row.hint)).toEqual([null]);
    expect(await memoryFacts()).toEqual([]);
    // The held alert is dropped the way an expired hold is: no title left, nothing owed.
    const [held] = await db.database
      .select()
      .from(schema.calendarEventSnapshots)
      .where(eq(schema.calendarEventSnapshots.eventId, 'yoga_1018'));
    expect(held).toMatchObject({
      pendingSince: null,
      heldTitle: null,
      heldLocation: null,
      startAt: NEXT_WEEK,
    });
  });

  it('refuses a kind that repeats a Gmail offer title the parent never added', async () => {
    const message = await alertMessage(emailAlertDedupeKey(gmailIntegrationId, 'msg-2'));
    await db.database.insert(schema.emailAlertOffers).values({
      familyId,
      parentUserId,
      integrationId: gmailIntegrationId,
      messageId: 'msg-2',
      kind: 'event',
      title: 'Book club',
      startsAt: NEXT_WEEK,
      channelMessageId: message,
      expiresAt: NEXT_WEEK,
    });
    await untrack({ kind: 'channel_message', id: message }, 'Book club');
    expect((await parentVerdicts()).map((row) => row.hint)).toEqual([null]);
    // The open offer is withdrawn: a later "yes" can no longer put it on the week.
    const [offer] = await db.database
      .select()
      .from(schema.emailAlertOffers)
      .where(eq(schema.emailAlertOffers.messageId, 'msg-2'));
    expect(offer).toMatchObject({ expiresAt: NOW, resolvedAt: null });
  });

  it('keeps the parent verdict when the model judges the same item again', async () => {
    const event = await mirror('one-off', NEXT_WEEK, 'Swim lesson');
    await untrack({ kind: 'family_event', id: event });

    let modelCalls = 0;
    const client = {
      messages: {
        create: async () => {
          modelCalls += 1;
          return {
            content: [
              {
                type: 'tool_use',
                id: 't',
                name: KID_VERDICT_TOOL,
                input: {
                  verdicts: [{ ref: 'i0', reason: 'swim', verdict: 'kid', childName: null }],
                },
              },
            ],
            stop_reason: 'tool_use',
            usage: { input_tokens: 1, output_tokens: 1 },
          };
        },
      },
    } as unknown as AgentClient;
    process.env.HALE_LLM_NO_STREAM = '1';
    const [judged] = await judgeKidRelevance(
      db.database,
      {
        familyId,
        items: [
          {
            ref: 'r',
            source: 'google_calendar',
            integrationId,
            itemKey: 'one-off',
            title: 'Swim lesson',
            startsAt: NEXT_WEEK.toISOString(),
            place: null,
            sender: null,
          },
        ],
        now: NOW,
        deadline: new Date('2099-01-01T00:00:00Z'),
      },
      { client, children: [], notMineHints: [] },
    );
    expect(modelCalls).toBe(0);
    expect(judged).toMatchObject({ verdict: 'adult' });
  });

  it('untracks an accepted Gmail offer by its message', async () => {
    const [event] = await db.database
      .insert(schema.familyEvents)
      .values({ familyId, title: 'Team dinner', startsAt: NEXT_WEEK, source: 'parent' })
      .returning({ id: schema.familyEvents.id });
    const message = await alertMessage(emailAlertDedupeKey(gmailIntegrationId, 'msg-1'));
    await db.database.insert(schema.emailAlertOffers).values({
      familyId,
      parentUserId,
      integrationId: gmailIntegrationId,
      messageId: 'msg-1',
      kind: 'event',
      title: 'Team dinner',
      startsAt: NEXT_WEEK,
      channelMessageId: message,
      expiresAt: NEXT_WEEK,
      eventId: event?.id,
    });

    const result = await untrack({ kind: 'channel_message', id: message });
    expect(result).toEqual({
      outcome: 'untracked',
      seenIn: 'gmail',
      cancelledReminders: 0,
      removedEvents: 1,
    });
    const [verdict] = await db.database
      .select()
      .from(schema.kidRelevanceVerdicts)
      .where(
        and(
          eq(schema.kidRelevanceVerdicts.familyId, familyId),
          eq(schema.kidRelevanceVerdicts.source, 'gmail'),
        ),
      );
    expect(verdict).toMatchObject({ itemKey: 'msg-1', integrationId: gmailIntegrationId });
  });

  it('names a target it cannot use instead of guessing', async () => {
    const plain = await alertMessage(null);
    expect(await untrack({ kind: 'channel_message', id: plain })).toEqual({
      outcome: 'not_provider_item',
    });
    const [authored] = await db.database
      .insert(schema.familyEvents)
      .values({ familyId, title: 'Party', startsAt: NEXT_WEEK, source: 'channel' })
      .returning({ id: schema.familyEvents.id });
    expect(await untrack({ kind: 'family_event', id: authored?.id ?? '' })).toEqual({
      outcome: 'not_provider_item',
    });
    expect(
      await untrack({ kind: 'family_event', id: '00000000-0000-4000-8000-000000000000' }),
    ).toEqual({ outcome: 'not_found' });

    const other = await seedFamily(db.database);
    const [theirs] = await db.database
      .insert(schema.familyEvents)
      .values({ familyId: other.familyId, title: 'Theirs', startsAt: NEXT_WEEK, source: 'parent' })
      .returning({ id: schema.familyEvents.id });
    expect(await untrack({ kind: 'family_event', id: theirs?.id ?? '' })).toEqual({
      outcome: 'not_found',
    });
  });

  it('a second untrack of the same series is already_untracked and writes nothing more', async () => {
    const event = await mirror('one-off', NEXT_WEEK);
    await untrack({ kind: 'family_event', id: event });
    expect(await untrack({ kind: 'family_event', id: event })).toEqual({
      outcome: 'already_untracked',
    });
    const audit = await db.database
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.familyId, familyId));
    expect(audit).toHaveLength(1);
  });
});
