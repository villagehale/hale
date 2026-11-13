import { type Database, type WorkstreamStatus, schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type OutboundGatePorts, buildOutboundGatePorts } from '~/lib/channel/outbound-gate';
import { queueCheckInForDecider } from '~/lib/channel/proactive/queue';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { NEXT_DAY_CHECKBACK_TEMPLATE_KEY, nextDayCheckbackDedupeKey } from './claim';
import { NEXT_DAY_CHECKBACK_ENABLED_ENV } from './flag';
import { type NextDayCheckbackDeps, runNextDayCheckbackSweep } from './sweep';

/**
 * The next-day check-back sweep, against real Postgres. The gate's consent reads are a
 * port here (outbound-gate.test.ts owns them); the candidate write is the real one.
 */

const ET = 'America/New_York';
/** Tuesday 22:40 EST: Hale's reply asked the parent to pick, and the row was labelled. */
const ANCHOR = new Date('2026-11-11T03:40:00.000Z');
/** Wednesday 08:17 EST: inside the next day (opens Wed 08:00, closes Thu 08:00). */
const NOW = new Date('2026-11-11T13:17:00.000Z');
const CLOSES = new Date('2026-11-12T13:00:00.000Z');
const TITLE = 'Fall swim registration for the 4 year old';
const NEXT = 'Pick one of the three sessions';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(() => {
  vi.stubEnv(NEXT_DAY_CHECKBACK_ENABLED_ENV, 'true');
  vi.stubEnv('WORKSTREAMS_ENABLED', 'true');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await db.exec('truncate table families, users cascade');
});

const openGate = (): OutboundGatePorts => ({
  channelEnrolled: async () => true,
  watchConsentGranted: async () => true,
  countProactiveSends: async () => 0,
  proactiveSentSince: async () => true,
  parentTimeZone: async () => ET,
});

/** The production zone port, which reads a parent's stored `users.timezone` as is. */
const storedZoneGate = (database: Database): OutboundGatePorts => ({
  ...openGate(),
  parentTimeZone: buildOutboundGatePorts(database).parentTimeZone,
});

function deps(over: Partial<NextDayCheckbackDeps> = {}): NextDayCheckbackDeps {
  return {
    buildGate: openGate,
    queueCandidate: queueCheckInForDecider,
    f14For: () => true,
    ...over,
  };
}

interface Seeded {
  familyId: string;
  primaryId: string;
  coParentId: string;
  childId: string;
  askId: string;
  workstreamId: string;
}

async function seed(
  over: {
    primaryZone?: string;
    askerZone?: string;
    status?: WorkstreamStatus;
    checkBackAt?: Date | null;
    lastFollowedUpAt?: Date | null;
    childAgeYears?: number;
    childName?: string;
    childIds?: 'child' | 'none';
    title?: string;
    updatedFrom?: 'ask' | 'expiry' | 'outbound';
  } = {},
): Promise<Seeded> {
  const [family] = await db.database
    .insert(schema.families)
    .values({ displayName: 'Test household', provinceOrState: 'ON' })
    .returning({ id: schema.families.id });
  const familyId = family?.id as string;
  const [primary] = await db.database
    .insert(schema.users)
    .values({ name: 'Primary', timezone: over.primaryZone ?? ET })
    .returning({ id: schema.users.id });
  const [co] = await db.database
    .insert(schema.users)
    .values({ name: 'Second', timezone: over.askerZone ?? ET })
    .returning({ id: schema.users.id });
  const primaryId = primary?.id as string;
  const coParentId = co?.id as string;
  await db.database.insert(schema.familyMembers).values([
    { familyId, userId: primaryId, role: 'primary_parent' },
    { familyId, userId: coParentId, role: 'co_parent' },
  ]);
  const born = new Date(NOW);
  born.setFullYear(born.getFullYear() - (over.childAgeYears ?? 4));
  const [child] = await db.database
    .insert(schema.children)
    .values({
      familyId,
      name: over.childName ?? 'Robin',
      dateOfBirth: born.toISOString().slice(0, 10),
    })
    .returning({ id: schema.children.id });
  const childId = child?.id as string;
  // The co-parent asked: their inbound is the turn the workstream was written from.
  const [ask] = await db.database
    .insert(schema.channelMessages)
    .values({
      familyId,
      parentUserId: coParentId,
      channel: 'sms',
      direction: 'in',
      category: 'reply',
      status: 'delivered',
      body: 'find swim for the fall?',
      createdAt: new Date(ANCHOR.getTime() - 60_000),
    })
    .returning({ id: schema.channelMessages.id });
  const askId = ask?.id as string;
  let updatedFrom = askId;
  if (over.updatedFrom === 'expiry') updatedFrom = 'expiry';
  if (over.updatedFrom === 'outbound') {
    const [out] = await db.database
      .insert(schema.channelMessages)
      .values({
        familyId,
        parentUserId: coParentId,
        channel: 'sms',
        direction: 'out',
        category: 'reply',
        status: 'sent',
        createdAt: ANCHOR,
      })
      .returning({ id: schema.channelMessages.id });
    updatedFrom = out?.id as string;
  }
  const [row] = await db.database
    .insert(schema.familyWorkstreams)
    .values({
      familyId,
      title: over.title ?? TITLE,
      status: over.status ?? 'waiting_on_parent',
      nextStep: NEXT,
      checkBackAt: over.checkBackAt ?? null,
      childIds: over.childIds === 'none' ? [] : [childId],
      createdFrom: askId,
      updatedFrom,
      createdAt: ANCHOR,
      updatedAt: ANCHOR,
      expiresAt: new Date(ANCHOR.getTime() + 14 * 86_400_000),
      lastFollowedUpAt: over.lastFollowedUpAt ?? null,
    })
    .returning({ id: schema.familyWorkstreams.id });
  return { familyId, primaryId, coParentId, childId, askId, workstreamId: row?.id as string };
}

async function inbound(familyId: string, from: string, at: Date): Promise<void> {
  await db.database.insert(schema.channelMessages).values({
    familyId,
    parentUserId: from,
    channel: 'sms',
    direction: 'in',
    category: 'reply',
    status: 'delivered',
    body: 'ok',
    createdAt: at,
  });
}

async function candidates(familyId: string) {
  return db.database
    .select()
    .from(schema.proactiveCandidates)
    .where(eq(schema.proactiveCandidates.familyId, familyId));
}

/** Every property read throws: proves a code path made no database call at all. */
const poisoned = new Proxy({} as Database, {
  get() {
    throw new Error('the sweep read the database');
  },
});

describe('runNextDayCheckbackSweep', () => {
  it('reads nothing while the lane flag is off, and queues the same seed once it is on', async () => {
    const seeded = await seed();
    vi.stubEnv(NEXT_DAY_CHECKBACK_ENABLED_ENV, 'false');
    const off = await runNextDayCheckbackSweep(poisoned, NOW, deps());
    expect(off).toMatchObject({ skipped: 'flag_off', examined: 0, queued: 0 });

    vi.stubEnv(NEXT_DAY_CHECKBACK_ENABLED_ENV, 'true');
    const on = await runNextDayCheckbackSweep(db.database, NOW, deps());
    expect(on).toMatchObject({ skipped: null, examined: 1, queued: 1 });
    expect(await candidates(seeded.familyId)).toHaveLength(1);
  });

  it('reads nothing while workstreams are off', async () => {
    vi.stubEnv('WORKSTREAMS_ENABLED', 'false');
    const result = await runNextDayCheckbackSweep(poisoned, NOW, deps());
    expect(result).toMatchObject({ skipped: 'workstreams_off', examined: 0 });
  });

  it('queues one check-back for the parent who asked, the next morning', async () => {
    const seeded = await seed();

    const result = await runNextDayCheckbackSweep(db.database, NOW, deps());

    expect(result).toMatchObject({ examined: 1, queued: 1, duplicate: 0, held: 0 });
    const [row] = await candidates(seeded.familyId);
    expect(row).toMatchObject({
      parentUserId: seeded.coParentId,
      kind: 'next_day_checkback',
      category: 'followup',
      templateKey: NEXT_DAY_CHECKBACK_TEMPLATE_KEY,
      dedupeKey: nextDayCheckbackDedupeKey(seeded.workstreamId),
      what: `${TITLE}: ${NEXT}`,
      why: `next_day_checkback asked=${ANCHOR.toISOString()}`,
      sourceUrl: null,
      worthlessAfter: CLOSES,
      parentRequested: false,
      status: 'queued',
      payload: {
        nextDayCheckback: {
          workstreamId: seeded.workstreamId,
          anchorAt: ANCHOR.toISOString(),
          subjectChildId: seeded.childId,
        },
      },
    });
    // The decider reads only `why`: no title, no child, no step.
    expect(row?.why).not.toContain('swim');
    const audits = await db.database
      .select()
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.familyId, seeded.familyId),
          eq(schema.auditLog.actionTaken, 'proactive_cadence_queued'),
        ),
      );
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      targetTable: 'family_workstreams',
      targetId: seeded.workstreamId,
      after: { kind: 'next_day_checkback' },
    });
  });

  it('queues an ask at most once: a later sweep never reads it again', async () => {
    const seeded = await seed();
    await runNextDayCheckbackSweep(db.database, NOW, deps());
    const again = await runNextDayCheckbackSweep(
      db.database,
      new Date(NOW.getTime() + 20 * 60_000),
      deps(),
    );
    expect(again).toMatchObject({ examined: 0, queued: 0, duplicate: 0 });
    expect(await candidates(seeded.familyId)).toHaveLength(1);
  });

  it('never reads an ask whose check-back is already on the send ledger', async () => {
    const seeded = await seed();
    await db.database.insert(schema.channelMessages).values({
      familyId: seeded.familyId,
      parentUserId: seeded.coParentId,
      channel: 'sms',
      direction: 'out',
      category: 'followup',
      status: 'sent',
      templateKey: NEXT_DAY_CHECKBACK_TEMPLATE_KEY,
      dedupeKey: nextDayCheckbackDedupeKey(seeded.workstreamId),
      createdAt: new Date(NOW.getTime() - 60_000),
    });
    const result = await runNextDayCheckbackSweep(db.database, NOW, deps());
    expect(result).toMatchObject({ examined: 0, queued: 0 });
    expect(await candidates(seeded.familyId)).toHaveLength(0);
  });

  it('offers a due ask that sits behind 250 asks whose day has passed', async () => {
    const seeded = await seed();
    // Monday 22:40 EST: their next day closed Wednesday 08:00, before NOW.
    const monday = new Date(ANCHOR.getTime() - 86_400_000);
    await db.database.insert(schema.familyWorkstreams).values(
      Array.from({ length: 250 }, (_, index) => ({
        familyId: seeded.familyId,
        title: `Older ask ${index}`,
        status: 'waiting_on_parent' as const,
        nextStep: NEXT,
        childIds: [seeded.childId],
        createdFrom: seeded.askId,
        updatedFrom: seeded.askId,
        createdAt: monday,
        updatedAt: monday,
        expiresAt: new Date(monday.getTime() + 14 * 86_400_000),
      })),
    );

    const result = await runNextDayCheckbackSweep(db.database, NOW, deps());

    expect(result).toMatchObject({ examined: 251, pastDay: 250, queued: 1 });
    const queued = await candidates(seeded.familyId);
    expect(queued.map((row) => row.dedupeKey)).toEqual([
      nextDayCheckbackDedupeKey(seeded.workstreamId),
    ]);
  });

  it('waits out the same evening, and lets a passed day go', async () => {
    const seeded = await seed();
    const evening = await runNextDayCheckbackSweep(
      db.database,
      new Date(ANCHOR.getTime() + 60 * 60_000),
      deps(),
    );
    expect(evening).toMatchObject({ tooSoon: 1, queued: 0 });
    // Thursday 08:17 EST: the one day closed at 08:00.
    const late = await runNextDayCheckbackSweep(
      db.database,
      new Date(CLOSES.getTime() + 17 * 60_000),
      deps(),
    );
    expect(late).toMatchObject({ pastDay: 1, queued: 0 });
    expect(await candidates(seeded.familyId)).toHaveLength(0);
  });

  it('skips an ask whose parent texted again, but not one where only the other parent did', async () => {
    const seeded = await seed();
    await inbound(seeded.familyId, seeded.primaryId, new Date(ANCHOR.getTime() + 60_000));
    const otherOnly = await runNextDayCheckbackSweep(db.database, NOW, deps());
    expect(otherOnly).toMatchObject({ parentReturned: 0, queued: 1 });

    const returned = await seed();
    await inbound(returned.familyId, returned.coParentId, new Date(ANCHOR.getTime() + 60_000));
    const result = await runNextDayCheckbackSweep(db.database, NOW, deps());
    expect(result).toMatchObject({ parentReturned: 1 });
    expect(await candidates(returned.familyId)).toHaveLength(0);
  });

  it('never examines a row that is not waiting on the parent, has a check-back, or was followed up', async () => {
    await seed({ status: 'open' });
    await seed({ status: 'waiting_on_third_party' });
    await seed({ status: 'done' });
    await seed({ checkBackAt: new Date(NOW.getTime() + 86_400_000) });
    await seed({ lastFollowedUpAt: new Date(ANCHOR.getTime() + 60_000) });
    const result = await runNextDayCheckbackSweep(db.database, NOW, deps());
    expect(result).toMatchObject({ examined: 0, queued: 0 });
  });

  it('skips a teen ask, by child id or by a title naming the teen', async () => {
    const byId = await seed({ childAgeYears: 15 });
    const byTitle = await seed({
      childAgeYears: 15,
      childName: 'Morgan',
      childIds: 'none',
      title: 'Driving lessons for Morgan',
    });
    const result = await runNextDayCheckbackSweep(db.database, NOW, deps());
    expect(result).toMatchObject({ teenScoped: 2, queued: 0 });
    expect(await candidates(byId.familyId)).toHaveLength(0);
    expect(await candidates(byTitle.familyId)).toHaveLength(0);
  });

  it('skips a row with no inbound asker, an unknown household clock, or a dark family', async () => {
    await seed({ updatedFrom: 'expiry' });
    await seed({ updatedFrom: 'outbound' });
    const asked = await runNextDayCheckbackSweep(db.database, NOW, deps());
    expect(asked).toMatchObject({ noAsker: 2, queued: 0 });
    await db.exec('truncate table families, users cascade');

    await seed({ primaryZone: 'UTC', askerZone: 'UTC' });
    const zone = await runNextDayCheckbackSweep(db.database, NOW, deps());
    expect(zone).toMatchObject({ zoneUnknown: 1, queued: 0 });
    await db.exec('truncate table families, users cascade');

    await seed();
    const dark = await runNextDayCheckbackSweep(db.database, NOW, deps({ f14For: () => false }));
    expect(dark).toMatchObject({ f14Dark: 1, queued: 0 });
  });

  it("keeps the next day on the asker's own clock", async () => {
    const LA = 'America/Los_Angeles';
    const seeded = await seed({ askerZone: LA });
    // Wednesday 05:17 PST: still the asker's night, though 08:17 in the household.
    const early = await runNextDayCheckbackSweep(db.database, NOW, deps());
    expect(early).toMatchObject({ tooSoon: 1, queued: 0 });

    const morning = await runNextDayCheckbackSweep(
      db.database,
      new Date('2026-11-11T16:17:00.000Z'),
      deps({ buildGate: storedZoneGate }),
    );
    expect(morning).toMatchObject({ queued: 1 });
    const [row] = await candidates(seeded.familyId);
    // Thursday 08:00 PST.
    expect(row?.worthlessAfter).toEqual(new Date('2026-11-12T16:00:00.000Z'));
  });

  it("reads an asker with the UTC default on the household's clock, never UTC's", async () => {
    const seeded = await seed({ askerZone: 'UTC' });
    // Thursday 05:00 EST: inside the next day and the household's quiet hours, though
    // 10:00 in UTC.
    const night = await runNextDayCheckbackSweep(
      db.database,
      new Date('2026-11-12T10:00:00.000Z'),
      deps({ buildGate: storedZoneGate }),
    );
    expect(night).toMatchObject({ held: 1, queued: 0 });
    expect(await candidates(seeded.familyId)).toHaveLength(0);

    const day = await runNextDayCheckbackSweep(
      db.database,
      NOW,
      deps({ buildGate: storedZoneGate }),
    );
    expect(day).toMatchObject({ queued: 1 });
    const [row] = await candidates(seeded.familyId);
    expect(row?.worthlessAfter).toEqual(CLOSES);
  });

  it('holds a parent the gate refuses without using up the one chance', async () => {
    const seeded = await seed();
    const refused = await runNextDayCheckbackSweep(
      db.database,
      NOW,
      deps({ buildGate: () => ({ ...openGate(), channelEnrolled: async () => false }) }),
    );
    expect(refused).toMatchObject({ held: 1, queued: 0 });
    expect(await candidates(seeded.familyId)).toHaveLength(0);

    const later = await runNextDayCheckbackSweep(db.database, NOW, deps());
    expect(later).toMatchObject({ queued: 1 });
  });
});
