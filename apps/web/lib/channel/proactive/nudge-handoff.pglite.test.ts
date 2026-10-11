import { schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { WEEKDAY_CARE_ENABLED_ENV, recordWeekdayCare } from '~/lib/care/weekday';
import { INTAKE_RADAR_WEEKEND_PICK_TEMPLATE_KEY } from '~/lib/channel/intake/radar';
import { FakeTransport } from '~/lib/channel/intake/transport';
import { type NudgeRunDeps, defaultNudgeRunDeps, runNudgeCron } from '~/lib/channel/nudge/run';
import type { OutboundGatePorts } from '~/lib/channel/outbound-gate';
import { CIVIC_SOURCE } from '~/lib/civic/project';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';

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

describe('the nudge hand-off', () => {
  it('sends the find and queues nothing while the flag is unset', async () => {
    const transport = new FakeTransport();
    const result = await runNudgeCron(db.database, deps(transport), MONDAY);
    expect(result).toMatchObject({ sent: 1, queued: 0 });
    expect(transport.bodies()[0]).toContain('Toddler drop-in');
    expect(await ledger()).toHaveLength(1);
    expect(await candidates()).toEqual([]);
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

    const again = await runNudgeCron(
      db.database,
      deps(transport),
      new Date(MONDAY.getTime() + 60 * 60_000),
    );
    expect(again).toMatchObject({ sent: 0, queued: 0 });
    expect(transport.sent).toEqual([]);
    expect(await candidates()).toHaveLength(1);
  });
});
