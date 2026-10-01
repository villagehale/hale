import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { biasFindOrder, readHouseholdFindBias } from '~/lib/reviews/household-bias';
import type { VerdictOutcome, VerdictReader } from '~/lib/reviews/verdict';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { runMidActivityAnswerPass } from './answer';
import { MID_ACTIVITY_ASK_TEMPLATE_KEY, midActivityAskDedupeKey } from './claim';
import { MID_ACTIVITY_ASK_ENABLED_ENV } from './flag';
import { runMidActivityAskSweep } from './sweep';

/**
 * The mid-activity ask, against real Postgres.
 *
 * The verdict reader is faked here for the same reason the review-capture suite
 * fakes it: the model's judgement is measured by the activity-verdict eval, and
 * this file measures the gate, the hold, and the row that changes the next find.
 */

const NOW = new Date('2026-06-03T15:00:00.000Z');
const WEEK_MS = 7 * 24 * 3_600_000;
const FIRST = Date.parse('2026-05-06T14:00:00.000Z');
const PLACE = 'places/riverdale-pool';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await db.exec('truncate table families, users cascade');
});

function weeklySessions(count: number, priceCents: number | null = null) {
  return Array.from({ length: count }, (_, i) => {
    const starts = new Date(FIRST + i * WEEK_MS).toISOString();
    return {
      id: `s${i}`,
      label: 'session',
      startsAt: starts,
      endsAt: starts,
      full: false,
      priceCents,
    };
  });
}

interface Seeded {
  familyId: string;
  parentUserId: string;
  childId: string;
  candidateId: string;
  offerId: string;
}

async function seed(
  options: {
    dateOfBirth?: string;
    cadence?: 'daily' | 'weekly' | 'off';
    placeId?: string | null;
    activityKey?: string;
    sessions?: ReturnType<typeof weeklySessions>;
    offerStatus?: string;
  } = {},
): Promise<Seeded> {
  const [family] = await db.database
    .insert(schema.families)
    .values({ displayName: 'Ana + kids', provinceOrState: 'ON', areaCoarse: 'M4K' })
    .returning({ id: schema.families.id });
  const familyId = family?.id as string;
  const [parent] = await db.database
    .insert(schema.users)
    .values({ externalAuthId: `sms:mid-${familyId}`, name: 'Ana', timezone: 'America/Toronto' })
    .returning({ id: schema.users.id });
  const parentUserId = parent?.id as string;
  await db.database.insert(schema.familyMembers).values({
    familyId,
    userId: parentUserId,
    role: 'primary_parent',
  });
  const [child] = await db.database
    .insert(schema.children)
    .values({
      familyId,
      name: 'Mia',
      dateOfBirth: options.dateOfBirth ?? '2023-03-01',
    })
    .returning({ id: schema.children.id });
  const childId = child?.id as string;
  const [candidate] = await db.database
    .insert(schema.villageCandidates)
    .values({
      familyId,
      title: 'Parent and tot swim',
      kind: 'class',
      summary: 'a weekly pool class',
      source: 'web_grounded',
      confidence: 0.9,
      placeId: options.placeId === undefined ? PLACE : options.placeId,
    })
    .returning({ id: schema.villageCandidates.id });
  const candidateId = candidate?.id as string;
  if (options.cadence) {
    await db.database.insert(schema.familyCheckInPrefs).values({
      familyId,
      cadence: options.cadence,
    });
  }
  const [offer] = await db.database
    .insert(schema.authorizedSignupOffers)
    .values({
      familyId,
      childId,
      parentUserId,
      activityKey: options.activityKey ?? candidateId,
      registrationUrl: 'https://example.com/register',
      sessions: options.sessions ?? weeklySessions(8),
      status: options.offerStatus ?? 'completed',
    })
    .returning({ id: schema.authorizedSignupOffers.id });
  return { familyId, parentUserId, childId, candidateId, offerId: offer?.id as string };
}

function arm() {
  vi.stubEnv(MID_ACTIVITY_ASK_ENABLED_ENV, 'true');
}

function reader(outcome: VerdictOutcome): VerdictReader & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async read(body) {
      calls.push(body);
      return outcome;
    },
  };
}

const WORTH_IT: VerdictOutcome = {
  status: 'read',
  verdict: 'worth_it',
  tags: ['well_run'],
  tagsDropped: 0,
};

describe('runMidActivityAskSweep', () => {
  it('does nothing when the flag is unset, off, or a trailing newline', async () => {
    await seed();
    for (const value of [undefined, 'false', 'true\n', 'on'] as const) {
      if (value === undefined) vi.unstubAllEnvs();
      else vi.stubEnv(MID_ACTIVITY_ASK_ENABLED_ENV, value);
      const result = await runMidActivityAskSweep(db.database, NOW);
      expect(result.skipped).toBe('flag_off');
      expect(result.placeholder).toBe(0);
      expect(result.examined).toBe(0);
    }
    expect(await db.database.select().from(schema.channelMessages)).toEqual([]);
  });

  it('holds one due ask as a placeholder and does not text or charge', async () => {
    await seed({ sessions: weeklySessions(8, 2500) });
    arm();

    const result = await runMidActivityAskSweep(db.database, NOW);

    expect(result.skipped).toBeNull();
    expect(result.placeholder).toBe(1);
    expect(result.unwired).toBe(0);
    expect(result.examined).toBe(1);
    const messages = await db.database.select().from(schema.channelMessages);
    expect(messages).toEqual([]);
    const reviews = await db.database.select().from(schema.activityReviews);
    expect(reviews).toEqual([]);
  });

  it('asks fewer when the parent has not chosen a cadence, and skips a short or off household', async () => {
    const quiet = await seed({ cadence: 'off' });
    arm();
    expect((await runMidActivityAskSweep(db.database, NOW)).preferenceOff).toBe(1);

    await db.exec('truncate table families, users cascade');
    await seed({ sessions: weeklySessions(1) });
    expect((await runMidActivityAskSweep(db.database, NOW)).tooRare).toBe(1);

    await db.exec('truncate table families, users cascade');
    await seed({ cadence: 'daily', sessions: weeklySessions(8) });
    expect((await runMidActivityAskSweep(db.database, NOW)).pastWindow).toBe(1);

    await db.exec('truncate table families, users cascade');
    const opaque = await seed({ activityKey: 'swim-parent-tot' });
    expect(opaque.offerId).toBeTruthy();
    expect((await runMidActivityAskSweep(db.database, NOW)).noSubject).toBe(1);
    expect(quiet.familyId).not.toBe(opaque.familyId);
  });

  it('does not ask about a teenager, and does not ask a second activity the same sweep', async () => {
    await seed({ dateOfBirth: '2010-01-01' });
    arm();
    expect((await runMidActivityAskSweep(db.database, NOW)).teenScoped).toBe(1);

    await db.exec('truncate table families, users cascade');
    const first = await seed();
    const [secondCandidate] = await db.database
      .insert(schema.villageCandidates)
      .values({
        familyId: first.familyId,
        title: 'Saturday library',
        kind: 'class',
        summary: 'another weekly class',
        source: 'web_grounded',
        confidence: 0.8,
        placeId: 'places/library',
      })
      .returning({ id: schema.villageCandidates.id });
    await db.database.insert(schema.authorizedSignupOffers).values({
      familyId: first.familyId,
      childId: first.childId,
      parentUserId: first.parentUserId,
      activityKey: secondCandidate?.id as string,
      registrationUrl: 'https://example.com/other',
      sessions: weeklySessions(8),
      status: 'completed',
    });

    const result = await runMidActivityAskSweep(db.database, NOW);
    expect(result.placeholder).toBe(1);
    expect(result.oneAtATime).toBe(1);
    expect(result.unwired).toBe(0);
  });

  it('treats a sent ask as already asked, so the next tick does not hold another', async () => {
    const seeded = await seed();
    await db.database.insert(schema.channelMessages).values({
      familyId: seeded.familyId,
      parentUserId: seeded.parentUserId,
      channel: 'sms',
      direction: 'out',
      category: 'followup',
      templateKey: MID_ACTIVITY_ASK_TEMPLATE_KEY,
      dedupeKey: midActivityAskDedupeKey(seeded.offerId),
      status: 'sent',
      createdAt: new Date('2026-06-03T14:30:00.000Z'),
    });
    arm();

    const result = await runMidActivityAskSweep(db.database, NOW);
    expect(result.alreadyAsked).toBe(1);
    expect(result.placeholder).toBe(0);
  });
});

describe('runMidActivityAnswerPass', () => {
  const askedAt = new Date('2026-06-03T18:00:00.000Z');
  const repliedAt = new Date('2026-06-03T18:20:00.000Z');
  const readAt = new Date('2026-06-03T18:40:00.000Z');

  async function seedAsk(dateOfBirth = '2023-03-01'): Promise<Seeded> {
    const seeded = await seed({ dateOfBirth });
    await db.database.insert(schema.channelMessages).values({
      familyId: seeded.familyId,
      parentUserId: seeded.parentUserId,
      channel: 'sms',
      direction: 'out',
      category: 'followup',
      templateKey: MID_ACTIVITY_ASK_TEMPLATE_KEY,
      dedupeKey: midActivityAskDedupeKey(seeded.offerId),
      status: 'sent',
      createdAt: askedAt,
    });
    await db.database.insert(schema.channelMessages).values({
      familyId: seeded.familyId,
      parentUserId: seeded.parentUserId,
      channel: 'sms',
      direction: 'in',
      category: 'reply',
      status: 'delivered',
      body: 'She loved the pool.',
      createdAt: repliedAt,
    });
    return seeded;
  }

  it('stores a worth-it verdict on the VIL-366 table and floats that place next', async () => {
    const seeded = await seedAsk();
    arm();
    const verdict = reader(WORTH_IT);

    const result = await runMidActivityAnswerPass(db.database, { verdict, now: readAt });

    expect(result.recorded).toBe(1);
    expect(verdict.calls).toEqual(['She loved the pool.']);
    const bias = await readHouseholdFindBias(db.database, seeded.familyId);
    expect([...bias.prefer]).toEqual([`place:${PLACE}`]);
    expect(
      biasFindOrder(
        [
          { id: 'other', placeId: 'places/other' },
          { id: 'this', placeId: PLACE },
        ],
        (item) => (item.placeId ? { source: 'place' as const, ref: item.placeId } : null),
        bias,
      ).map((item) => item.id),
    ).toEqual(['this', 'other']);

    const [audit] = await db.database
      .select({ after: schema.auditLog.after })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.actionTaken, 'activity_verdict_read'));
    expect(JSON.stringify(audit?.after)).not.toContain('She loved the pool');
    const outbound = await db.database
      .select()
      .from(schema.channelMessages)
      .where(eq(schema.channelMessages.direction, 'out'));
    expect(outbound).toHaveLength(1);
    expect(JSON.stringify(outbound)).not.toContain('TODO-Design');
    expect(JSON.stringify(outbound)).not.toMatch(/\bSTOP\b/);
  });

  it('drops a not-worth-it place from the next find when another option remains', async () => {
    const seeded = await seedAsk();
    arm();
    await runMidActivityAnswerPass(db.database, {
      verdict: reader({
        status: 'read',
        verdict: 'not_worth_it',
        tags: [],
        tagsDropped: 0,
      }),
      now: readAt,
    });

    const bias = await readHouseholdFindBias(db.database, seeded.familyId);
    expect([...bias.avoid]).toEqual([`place:${PLACE}`]);
    expect(
      biasFindOrder(
        [
          { id: 'this', placeId: PLACE },
          { id: 'other', placeId: 'places/other' },
        ],
        (item) => ({ source: 'place' as const, ref: item.placeId }),
        bias,
      ).map((item) => item.id),
    ).toEqual(['other']);
  });

  it('does not read when the flag is off, and does not read a teenager', async () => {
    await seedAsk();
    const dark = reader(WORTH_IT);
    const skipped = await runMidActivityAnswerPass(db.database, { verdict: dark, now: readAt });
    expect(skipped.skipped).toBe('flag_off');
    expect(dark.calls).toEqual([]);

    await db.exec('truncate table families, users cascade');
    await seedAsk('2010-01-01');
    arm();
    const teen = reader(WORTH_IT);
    const result = await runMidActivityAnswerPass(db.database, { verdict: teen, now: readAt });
    expect(result.teenScoped).toBe(1);
    expect(teen.calls).toEqual([]);
    expect(await db.database.select().from(schema.activityReviews)).toEqual([]);
  });
});
