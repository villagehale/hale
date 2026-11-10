import { join } from 'node:path';
import type { AgentClient } from '@hale/agent';
import { type Database, schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeTransport } from '~/lib/channel/intake/transport';
import type { OutboundGatePorts } from '~/lib/channel/outbound-gate';
import { recordCommitment } from '~/lib/commitments/ledger';
import { pipelineClient } from '~/lib/pipeline/client';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { recordedModel } from '~/lib/testing/recorded-model';
import {
  closeWatchOnCalendar,
  createWatchCalendarCheck,
  createWatchCalendarReader,
  loadWatchCalendar,
} from './calendar-check';
import { productionActivityFamilyReader } from './reader';
import {
  type ActivityFollowUpDeps,
  defaultActivityFollowUpDeps,
  runActivityFollowUpSweep,
} from './sweep';

/**
 * VIL-564 · a watch ends when the family's calendar already holds the activity — over
 * real Postgres and a real (recorded) model read.
 *
 * Re-record with HALE_RECORD=1, a live key, HALE_MAX_USD and HALE_SPEND_LEDGER
 * (lib/testing/recorded-model.ts), then commit the JSON.
 */

const RECORDINGS = join(import.meta.dirname, '__recordings__', 'watch-calendar-read.json');
const RECORD_TIMEOUT = process.env.HALE_RECORD === '1' ? 120_000 : undefined;

const ZONE = 'America/Chicago';
/** Tuesday 09:00 on the family's clock. */
const NOW = new Date('2026-12-01T15:00:00.000Z');
const SUBJECT = 'parent and tot swim lessons for a 2 year old';
const HEARD = ['price:money:$96', 'when:date:jan-9', 'when:day:sat', 'when:time:9:15'];

const openGate: OutboundGatePorts = {
  channelEnrolled: async () => true,
  watchConsentGranted: async () => true,
  countProactiveSends: async () => 0,
  proactiveSentSince: async () => true,
  parentTimeZone: async () => ZONE,
};

let db: TestDb;
let database: Database;
let familyId: string;
let parentUserId: string;
let toddlerId: string;
let teenId: string;
let watchId: string;

beforeAll(async () => {
  db = await createTestDb();
  database = db.database;
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  vi.stubEnv('F14_ENABLED', 'true');
  await db.exec('truncate table families, users cascade');
  const [family] = await database
    .insert(schema.families)
    .values({ displayName: 'Test family', provinceOrState: 'IL', countryCode: 'US' })
    .returning({ id: schema.families.id });
  familyId = family?.id as string;
  const [user] = await database
    .insert(schema.users)
    .values({ name: null, timezone: ZONE })
    .returning({ id: schema.users.id });
  parentUserId = user?.id as string;
  await database
    .insert(schema.familyMembers)
    .values({ familyId, userId: parentUserId, role: 'primary_parent' });
  const [toddler, teen] = await database
    .insert(schema.children)
    .values([
      { familyId, name: 'Mia', dateOfBirth: '2024-09-01' },
      { familyId, name: 'Rowan', dateOfBirth: '2011-03-01' },
    ])
    .returning({ id: schema.children.id });
  toddlerId = toddler?.id as string;
  teenId = teen?.id as string;

  // The follow-up that said "I'll keep watching", and the watch it registered.
  const [carried] = await database
    .insert(schema.channelMessages)
    .values({
      familyId,
      parentUserId,
      channel: 'sms',
      direction: 'out',
      category: 'activity_followup',
      status: 'sent',
    })
    .returning({ id: schema.channelMessages.id });
  const recorded = await recordCommitment(database, {
    familyId,
    kind: 'activity_followup',
    summary: `A promise to come back with what I find on ${SUBJECT}`,
    topic: SUBJECT,
    subjectChildId: toddlerId,
    heardFacts: HEARD,
    dueAt: new Date(NOW.getTime() - 3_600_000),
    channelMessageId: carried?.id as string,
  });
  if (recorded.status !== 'recorded') throw new Error('fixture: the watch was not recorded');
  watchId = recorded.commitmentId;

  await database.insert(schema.familyEvents).values([
    {
      familyId,
      childId: null,
      title: 'Dentist',
      startsAt: new Date('2026-12-03T21:30:00.000Z'),
      source: 'parent',
    },
    {
      familyId,
      childId: teenId,
      title: 'Volleyball tryouts',
      startsAt: new Date('2026-12-05T16:00:00.000Z'),
      source: 'parent',
    },
    {
      familyId,
      childId: null,
      title: 'Rowan driving lesson',
      startsAt: new Date('2026-12-06T18:00:00.000Z'),
      source: 'parent',
    },
    {
      familyId,
      childId: null,
      title: 'Allergist follow-up',
      startsAt: new Date('2026-12-08T15:00:00.000Z'),
      source: 'parent',
      sensitive: true,
    },
  ]);
});

async function addTheClass() {
  await database.insert(schema.familyEvents).values({
    familyId,
    childId: toddlerId,
    title: 'Parent & Tot Swim',
    startsAt: new Date('2027-01-09T15:15:00.000Z'),
    endsAt: new Date('2027-01-09T15:45:00.000Z'),
    source: 'parent',
  });
}

function sweepDeps(
  client: () => AgentClient,
  overrides: Partial<ActivityFollowUpDeps> = {},
): ActivityFollowUpDeps {
  return {
    ...defaultActivityFollowUpDeps(),
    calendarCheck: createWatchCalendarCheck(createWatchCalendarReader(client)),
    closeWatch: closeWatchOnCalendar,
    buildGate: () => openGate,
    deep: {
      async research() {
        return { status: 'unavailable', reason: 'client_unavailable' };
      },
    },
    transport: new FakeTransport(),
    ...overrides,
  };
}

async function watchRow() {
  const [row] = await database
    .select({
      cancelledAt: schema.agentCommitments.cancelledAt,
      cancelledReason: schema.agentCommitments.cancelledReason,
      fulfilledAt: schema.agentCommitments.fulfilledAt,
    })
    .from(schema.agentCommitments)
    .where(eq(schema.agentCommitments.id, watchId));
  return row;
}

function cancelAudits() {
  return database
    .select({ targetId: schema.auditLog.targetId, after: schema.auditLog.after })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.familyId, familyId),
        eq(schema.auditLog.actionTaken, 'commitment_cancelled'),
      ),
    );
}

describe('a watch on a class the family already has', { timeout: RECORD_TIMEOUT }, () => {
  it('is closed with a named reason and an audit row, and nothing is searched or sent', async () => {
    await addTheClass();
    const model = recordedModel(RECORDINGS, pipelineClient);
    const transport = new FakeTransport();
    let searched = 0;
    vi.spyOn(console, 'info').mockImplementation(() => undefined);

    const result = await runActivityFollowUpSweep(
      database,
      sweepDeps(model.client, {
        transport,
        finder: {
          async find() {
            searched += 1;
            return { found: false, reason: 'ground_failed' };
          },
        },
      }),
      NOW,
    );

    expect(model.misses).toEqual([]);
    expect(result).toMatchObject({ due: 1, sent: 0, onCalendar: 1, calendarUnchecked: 0 });
    expect(searched).toBe(0);
    expect(transport.bodies()).toEqual([]);
    expect(await watchRow()).toMatchObject({
      cancelledAt: NOW,
      cancelledReason: 'already_on_calendar',
      fulfilledAt: null,
    });
    expect(await cancelAudits()).toEqual([
      { targetId: watchId, after: { kind: 'activity_followup', reason: 'already_on_calendar' } },
    ]);
  });

  it("never shows the model a teen's entry or a health entry (rule #1)", async () => {
    await addTheClass();
    const model = recordedModel(RECORDINGS, pipelineClient);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);

    await runActivityFollowUpSweep(database, sweepDeps(model.client), NOW);

    const [request] = model.requests;
    // POSITIVE CONTROL: the household's own entries do reach it, on the family's clock.
    expect(request).toContain('Dentist');
    expect(request).toContain('"day":"2027-01-09 (Saturday)","start":"09:15"');
    expect(request).not.toContain('Volleyball');
    expect(request).not.toContain('Rowan');
    expect(request).not.toContain('Allergist');
  });

  it('a newer promise written after the read is not voided by that decision', async () => {
    await database
      .update(schema.agentCommitments)
      .set({ cancelledAt: NOW, cancelledReason: 'activity_promise_superseded' })
      .where(eq(schema.agentCommitments.id, watchId));
    const [carried] = await database
      .select({ id: schema.channelMessages.id })
      .from(schema.channelMessages)
      .where(eq(schema.channelMessages.familyId, familyId));
    const newer = await recordCommitment(database, {
      familyId,
      kind: 'activity_followup',
      summary: 'A promise to come back with what I find on toddler gymnastics',
      topic: 'toddler gymnastics',
      dueAt: NOW,
      channelMessageId: carried?.id as string,
    });

    const closed = await closeWatchOnCalendar(database, {
      commitmentId: watchId,
      familyId,
      now: NOW,
    });

    expect(closed).toEqual({ status: 'none_open' });
    const [open] = await database
      .select({ cancelledAt: schema.agentCommitments.cancelledAt })
      .from(schema.agentCommitments)
      .where(
        eq(
          schema.agentCommitments.id,
          newer.status === 'recorded' ? newer.commitmentId : 'missing',
        ),
      );
    expect(open).toEqual({ cancelledAt: null });
  });
});

describe('a watch with no named child', () => {
  it("still keeps a teen's entries from the model (rule #1)", async () => {
    const read = await loadWatchCalendar(database, {
      familyId,
      parentUserId,
      subjectChildId: null,
      now: NOW,
    });

    if (read.status !== 'read') throw new Error(`expected a read, got ${read.status}`);
    const titles = read.calendar.map((entry) => entry.title);
    // POSITIVE CONTROL: a household entry for no child still reaches the model.
    expect(titles).toContain('Dentist');
    expect(titles).not.toContain('Volleyball tryouts');
    expect(titles).not.toContain('Rowan driving lesson');
  });
});

describe('a calendar check that fails', () => {
  it('keeps the watch open and goes on to look, with the named outcome counted', async () => {
    await addTheClass();
    const outage = {
      messages: {
        create: async () => {
          throw new Error('provider unreachable');
        },
        stream: () => ({
          finalMessage: async () => {
            throw new Error('provider unreachable');
          },
        }),
      },
    } as unknown as AgentClient;
    let searched = 0;
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await runActivityFollowUpSweep(
      database,
      sweepDeps(() => outage, {
        // A town to search in: the family row carries no postal area.
        reader: {
          ...productionActivityFamilyReader(),
          place: async () => ({ status: 'known', town: 'Springfield' }),
        },
        finder: {
          async find() {
            searched += 1;
            return { found: false, reason: 'ground_failed' };
          },
        },
      }),
      NOW,
    );

    expect(result).toMatchObject({ due: 1, onCalendar: 0, calendarUnchecked: 1 });
    expect(warn).toHaveBeenCalledWith(
      { commitmentId: watchId, outcome: 'calendar_unchecked', reason: 'read_failed' },
      expect.any(String),
    );
    // Today's behaviour: the look still ran.
    expect(searched).toBe(1);
    expect(await watchRow()).toMatchObject({ cancelledAt: null, fulfilledAt: null });
    expect(await cancelAudits()).toEqual([]);
  });
});
