import { schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { WEEKDAY_CARE_ENABLED_ENV, recordWeekdayCare } from '~/lib/care/weekday';
import { INTAKE_RADAR_WEEKEND_PICK_TEMPLATE_KEY } from '~/lib/channel/intake/radar';
import { FakeTransport } from '~/lib/channel/intake/transport';
import {
  type NudgeRunDeps,
  defaultNudgeRunDeps,
  nudgeLane,
  nudgeWorthlessAfter,
  runNudgeCron,
} from '~/lib/channel/nudge/run';
import type { OutboundGatePorts } from '~/lib/channel/outbound-gate';
import { threadProactiveMessage } from '~/lib/channel/thread';
import { CIVIC_SOURCE } from '~/lib/civic/project';
import { fulfillCommitment } from '~/lib/commitments/ledger';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { type ProactiveReviewDeps, runProactiveReview } from './review';

/**
 * `live` arms only once every proactive class is routed (flag.ts PROACTIVE_ROUTING). The
 * live path here is tested as it will run then; `routing.complete = false` is today's
 * table, where a requested live runs as shadow.
 */
const routing = vi.hoisted(() => ({ complete: true }));
vi.mock('~/lib/channel/proactive/flag', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/lib/channel/proactive/flag')>();
  return {
    ...actual,
    proactiveCadence: () =>
      routing.complete ? actual.requestedCadence() : actual.proactiveCadence(),
  };
});

/**
 * VIL-226 · the nudge sweep's hand-off to the family queue, over real Postgres and the
 * real decide. A weekday drop-in find is the subject because it needs no model: the
 * deterministic render IS its text, so the three modes differ only in what the flag
 * does. Unset is the positive control — the find goes out and nothing is queued.
 */

const TZ = 'America/New_York';
/** 10:00 local on Monday 2026-08-10, the tick before the Tuesday session. */
const MONDAY = new Date('2026-08-10T14:00:00.000Z');
const TUESDAY_KEY = '2026-08-11';
const PHONE = '+15555550100';
const DROPIN_TEMPLATE = 'proactive_nudge:weekday_dropin';

let db: TestDb;
let familyId: string;
let parentUserId: string;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  routing.complete = true;
  await db.exec('truncate table families, users cascade');
  vi.unstubAllEnvs();
  vi.stubEnv('F14_ENABLED', 'true');
  vi.stubEnv(WEEKDAY_CARE_ENABLED_ENV, 'true');

  const [family] = await db.database
    .insert(schema.families)
    .values({
      displayName: 'Rowan + kids',
      provinceOrState: 'ON',
      onboardingStage: 'sms_active',
      createdAt: new Date('2026-07-01T00:00:00.000Z'),
    })
    .returning({ id: schema.families.id });
  familyId = family?.id as string;
  const [user] = await db.database
    .insert(schema.users)
    .values({ externalAuthId: 'sms:handoff', name: 'Rowan', timezone: TZ })
    .returning({ id: schema.users.id });
  parentUserId = user?.id as string;
  await db.database
    .insert(schema.familyMembers)
    .values({ familyId, userId: parentUserId, role: 'primary_parent' });
  const [toddler] = await db.database
    .insert(schema.children)
    .values({ familyId, name: 'Pip', dateOfBirth: '2024-06-01' })
    .returning({ id: schema.children.id });

  await db.database.insert(schema.villageCandidates).values({
    familyId,
    title: 'Toddler drop-in',
    kind: 'drop_in',
    summary: 'Free drop-in at Maple Hall - 9:30 a.m.-11:00 a.m.',
    source: CIVIC_SOURCE,
    runType: 'civic',
    eventDate: TUESDAY_KEY,
    venueName: 'Maple Hall',
    priceLevel: 'free',
    indoorOutdoor: 'indoor',
    confidence: 0.9,
    discoveredAt: new Date('2026-08-03T15:57:00.000Z'),
  });
  await db.database.insert(schema.channelMessages).values({
    familyId,
    parentUserId,
    channel: 'sms',
    direction: 'out',
    category: 'intake',
    templateKey: INTAKE_RADAR_WEEKEND_PICK_TEMPLATE_KEY,
    status: 'delivered',
    createdAt: new Date('2026-08-03T18:00:00.000Z'),
  });
  await recordWeekdayCare(db.database, {
    familyId,
    parentUserId,
    childId: toddler?.id as string,
    care: 'home',
    provider: null,
    now: new Date('2026-08-07T15:00:00.000Z'),
  });
});

const openGate = (): OutboundGatePorts => ({
  channelEnrolled: async () => true,
  watchConsentGranted: async () => true,
  countProactiveSends: async () => 0,
  proactiveSentSince: async () => false,
  parentTimeZone: async () => TZ,
});

function deps(transport: FakeTransport): NudgeRunDeps {
  return {
    ...defaultNudgeRunDeps(),
    selectFamilies: async () => [
      {
        familyId,
        parentUserId,
        areaCoarse: null,
        timeZone: TZ,
        provisionedAt: new Date('2026-07-01T00:00:00.000Z'),
      },
    ],
    loadRecipients: async () => [{ parentUserId, timeZone: TZ, role: 'primary_parent' as const }],
    resolveSendablePhone: async () => PHONE,
    weather: { getDailyOutlook: async () => [] },
    buildGate: openGate,
    transport,
    client: null,
  };
}

async function candidates() {
  return db.database
    .select()
    .from(schema.proactiveCandidates)
    .where(eq(schema.proactiveCandidates.familyId, familyId));
}

async function ledger() {
  return db.database
    .select()
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.familyId, familyId),
        eq(schema.channelMessages.templateKey, DROPIN_TEMPLATE),
      ),
    );
}

/** What a send leaves for every later reader: the ledger, the thread, the trail. */
async function sendTrail() {
  const rows = await ledger();
  const thread = await db.database
    .select({ role: schema.messages.role, content: schema.messages.content })
    .from(schema.messages)
    .innerJoin(schema.conversations, eq(schema.conversations.id, schema.messages.conversationId))
    .where(eq(schema.conversations.familyId, familyId));
  const sent = await db.database
    .select()
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.familyId, familyId),
        eq(schema.auditLog.actionTaken, 'proactive_nudge_sent'),
      ),
    );
  return {
    ledger: rows.map((row) => ({
      parentUserId: row.parentUserId,
      direction: row.direction,
      category: row.category,
      templateKey: row.templateKey,
      dedupeKey: row.dedupeKey,
    })),
    ledgerIds: rows.map((row) => row.id),
    thread,
    sent: sent.map((row) => ({
      targetTable: row.targetTable,
      targetId: row.targetId,
      kind: (row.after as { kind?: unknown }).kind,
    })),
  };
}

/** One find, one parent: the rows a sweep send leaves, whichever path sent it. */
function expectFindSent(trail: Awaited<ReturnType<typeof sendTrail>>, body: string | undefined) {
  expect(trail.ledger).toEqual([
    {
      parentUserId,
      direction: 'out',
      category: 'nudge',
      templateKey: DROPIN_TEMPLATE,
      dedupeKey: `nudge:${familyId}:weekday_dropin:2026-08-10:${parentUserId}`,
    },
  ]);
  expect(trail.thread).toEqual([{ role: 'assistant', content: body }]);
  expect(trail.sent).toEqual([
    { targetTable: 'channel_messages', targetId: trail.ledgerIds[0], kind: 'weekday_dropin' },
  ]);
}

describe('the nudge hand-off', () => {
  it('sends the find and queues nothing while the flag is unset', async () => {
    const transport = new FakeTransport();
    const result = await runNudgeCron(db.database, deps(transport), MONDAY);
    expect(result).toMatchObject({ sent: 1, queued: 0 });
    expect(transport.bodies()[0]).toContain('Toddler drop-in');
    expectFindSent(await sendTrail(), transport.bodies()[0]);
    expect(await candidates()).toEqual([]);
  });

  it('when live, the decider’s send leaves the same rows the sweep’s send leaves', async () => {
    vi.stubEnv('PROACTIVE_CADENCE', 'live');
    const transport = new FakeTransport();
    await runNudgeCron(db.database, deps(transport), MONDAY);
    expect(transport.sent).toEqual([]);
    const [queued] = await candidates();

    const review: ProactiveReviewDeps = {
      client: null,
      transport,
      decide: async ({ snapshot }) => ({
        decision: {
          reason: 'Tuesday morning is open',
          action: 'send_now',
          itemIds: snapshot.candidates.map((item) => item.id),
          holdUntil: null,
          frequencyPreference: null,
        },
        skipped: null,
      }),
      compose: async ({ items }) => ({ message: items.map((item) => item.what).join(' ') }),
      buildGate: openGate,
      resolveSendablePhone: async () => PHONE,
      linePaused: async () => false,
      loadRecipients: async () => [{ parentUserId, timeZone: TZ, role: 'primary_parent' }],
      outboundTarget: async () => ({ channel: 'legacy' }),
      threadMessage: threadProactiveMessage,
      fulfillCommitment,
    };
    const summary = await runProactiveReview(db.database, review, MONDAY);

    expect(summary).toMatchObject({ sent: 1 });
    expect(transport.bodies()).toEqual([queued?.what]);
    expectFindSent(await sendTrail(), queued?.what);
  });

  it('in shadow, sends the find and also queues it for the decider', async () => {
    vi.stubEnv('PROACTIVE_CADENCE', 'shadow');
    const transport = new FakeTransport();
    const result = await runNudgeCron(db.database, deps(transport), MONDAY);
    expect(result).toMatchObject({ sent: 1, queued: 0 });
    const [row] = await ledger();
    const stored = await candidates();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      parentUserId,
      kind: 'nudge',
      category: 'nudge',
      templateKey: DROPIN_TEMPLATE,
      dedupeKey: row?.dedupeKey,
      status: 'queued',
      parentRequested: false,
      // The end of the Tuesday the session is on, in the family's zone.
      worthlessAfter: new Date('2026-08-12T04:00:00.000Z'),
    });
    expect(stored[0]?.what).toContain('Toddler drop-in');
  });

  it('when live, queues the find instead of sending it, and does not queue it twice', async () => {
    vi.stubEnv('PROACTIVE_CADENCE', 'live');
    const transport = new FakeTransport();
    const result = await runNudgeCron(db.database, deps(transport), MONDAY);
    expect(result).toMatchObject({ sent: 0, queued: 1 });
    expect(transport.sent).toEqual([]);
    expect(await ledger()).toEqual([]);
    expect(await candidates()).toHaveLength(1);
    const [skipped] = await db.database
      .select()
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.familyId, familyId),
          eq(schema.auditLog.actionTaken, 'proactive_nudge_queued'),
        ),
      );
    expect(skipped?.after).toMatchObject({ kind: 'weekday_dropin' });
    expect(skipped).toMatchObject({ targetTable: 'families', targetId: familyId });

    // A re-fired cron on the same tick decides the same find. The queued row is what
    // stops it, before the compose, so the re-fire costs nothing.
    const again = await runNudgeCron(db.database, deps(transport), MONDAY);
    expect(again).toMatchObject({ sent: 0, queued: 0, deduped: 1 });
    expect(transport.sent).toEqual([]);
    expect(await candidates()).toHaveLength(1);
  });

  it('runs a requested live as shadow while any class is unrouted', async () => {
    routing.complete = false;
    vi.stubEnv('PROACTIVE_CADENCE', 'live');
    const transport = new FakeTransport();
    const result = await runNudgeCron(db.database, deps(transport), MONDAY);
    expect(result).toMatchObject({ sent: 1, queued: 0 });
    expect(await ledger()).toHaveLength(1);
    expect(await candidates()).toHaveLength(1);
  });
});

describe('when a queued nudge stops being worth a text', () => {
  it('is the end of the local day it is about, and never for an ask about no day', () => {
    const swap = {
      kind: 'weather_swap' as const,
      candidateRef: { id: 'c-1', title: 'Indoor climbing', venueName: null },
      day: 'sunday' as const,
      kidNames: [],
      weatherFact: 'the weekend forecast is wet',
      whyFacts: [],
    };
    // Monday in New York; the coming Sunday is 2026-08-16.
    expect(nudgeWorthlessAfter(swap, MONDAY, TZ)).toEqual(new Date('2026-08-17T04:00:00.000Z'));
    expect(
      nudgeWorthlessAfter(
        { kind: 'weekday_care', ask: { prompt: 'weekend_fallback' } },
        MONDAY,
        TZ,
      ),
    ).toBeNull();
  });
});

/**
 * The two nudge kinds that never wait for the decider: a registration window runs on the
 * town's clock, and a health checkpoint is reviewed static copy. Live sends them at once.
 * The checkpoint runs end to end here (an Ontario area so the matcher has a region). A
 * registration nudge needs a covered municipality and its postal codes, which fixtures
 * do not carry, so its lane is pinned on the mapping the sweep uses.
 */
describe('the nudge kinds that never queue', () => {
  it('maps registration and health checkpoints to the immediate lane, and nothing else', () => {
    expect(nudgeLane('registration')).toBe('immediate');
    expect(nudgeLane('health_checkpoint')).toBe('immediate');
    for (const kind of [
      'weather_swap',
      'weekday_dropin',
      'weekday_care',
      'empty_saturday',
    ] as const) {
      expect(nudgeLane(kind)).toBe('candidate');
    }
  });

  const AREA = 'K0A';

  function areaDeps(transport: FakeTransport): NudgeRunDeps {
    return {
      ...deps(transport),
      selectFamilies: async () => [
        {
          familyId,
          parentUserId,
          areaCoarse: AREA,
          timeZone: TZ,
          provisionedAt: new Date('2026-07-01T00:00:00.000Z'),
        },
      ],
    };
  }

  it('when live, sends a health checkpoint at once and queues nothing', async () => {
    vi.stubEnv('PROACTIVE_CADENCE', 'live');
    await db.database
      .insert(schema.children)
      .values({ familyId, name: 'Wren', dateOfBirth: '2026-02-10' });
    const transport = new FakeTransport();
    const result = await runNudgeCron(db.database, areaDeps(transport), MONDAY);
    expect(result).toMatchObject({ sent: 1, queued: 0 });
    expect(transport.sent).toHaveLength(1);
    const health = await db.database
      .select()
      .from(schema.channelMessages)
      .where(
        and(
          eq(schema.channelMessages.familyId, familyId),
          eq(schema.channelMessages.templateKey, 'proactive_nudge:health_checkpoint'),
        ),
      );
    expect(health).toHaveLength(1);
    expect(await candidates()).toEqual([]);
  });
});
