import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { biasFindOrder, readHouseholdFindBias } from '~/lib/reviews/household-bias';
import type { VerdictOutcome, VerdictReader } from '~/lib/reviews/verdict';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { runMidActivityAnswerPass } from './answer';
import { MID_ACTIVITY_ASK_TEMPLATE_KEY, midActivityAskDedupeKey } from './claim';
import { midActivityStartDedupeKey } from './claim';
import { MID_ACTIVITY_ASK_ENABLED_ENV } from './flag';
import { noteActivitySignupTool } from './said-tool';
import { type MidActivityAskDeps, queueSaidSignupAsk, runMidActivityAskSweep } from './sweep';

/** A gate that allows: this file measures the sweep, not consent or quiet hours. */
function openDeps(): MidActivityAskDeps {
  return {
    buildGate: () =>
      ({
        channelEnrolled: async () => true,
        watchConsentGranted: async () => true,
        countProactiveSends: async () => 0,
        proactiveSentSince: async () => true,
        parentTimeZone: async () => 'America/Toronto',
      }) as unknown as ReturnType<MidActivityAskDeps['buildGate']>,
    dedupeActive: async () => false,
    queueCandidate: async (database, draft) => {
      const inserted = await database
        .insert(schema.proactiveCandidates)
        .values({ ...draft, status: 'queued' })
        .onConflictDoNothing()
        .returning({ id: schema.proactiveCandidates.id });
      return inserted.length === 0 ? 'duplicate' : 'queued';
    },
  };
}

/**
 * The mid-activity ask, against real Postgres.
 *
 * The verdict reader is faked here for the same reason the review-capture suite
 * fakes it: the model's judgement is measured by the activity-verdict eval, and
 * this file measures the gate, the hold, and the row that changes the next find.
 */

const WEEK_MS = 7 * 24 * 3_600_000;
/** First session: 11:00 Toronto on 2 June; it ends (default length) at 12:00. */
const FIRST = Date.parse('2026-06-02T15:00:00.000Z');
/** 19:00 Toronto the same day: inside the evening-after-first-session window. */
const NOW = new Date('2026-06-02T23:00:00.000Z');
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
    .insert(schema.familyActivityHistory)
    .values({
      familyId,
      title: 'Parent and tot swim',
      kind: 'class',
      summary: 'a weekly pool class',
      source: 'web_grounded',
      confidence: 0.9,
      placeId: options.placeId === undefined ? PLACE : options.placeId,
    })
    .returning({ id: schema.familyActivityHistory.id });
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
      expect(result.examined).toBe(0);
    }
    expect(await db.database.select().from(schema.channelMessages)).toEqual([]);
  });

  it('queues one ask the evening after the first session, facts only, and does not text', async () => {
    const seeded = await seed({ sessions: weeklySessions(8, 2500) });
    arm();

    const result = await runMidActivityAskSweep(db.database, NOW, openDeps());

    expect(result.skipped).toBeNull();
    expect(result.queued).toBe(1);
    const [row] = await db.database.select().from(schema.proactiveCandidates);
    expect(row?.kind).toBe('mid_activity_ask');
    expect(row?.templateKey).toBe(MID_ACTIVITY_ASK_TEMPLATE_KEY);
    expect(row?.dedupeKey).toBe(midActivityAskDedupeKey(seeded.offerId));
    // Facts only: the activity's own title, and when the first session ended.
    expect(row?.what).toBe('Parent and tot swim');
    expect(row?.why).toContain('first_session_ended=2026-06-02T16:00:00.000Z');
    expect(row?.why).not.toMatch(/how .* going/i);
    // Lapses 08:00 Toronto the next morning.
    expect(row?.worthlessAfter).toEqual(new Date('2026-06-03T12:00:00.000Z'));
    expect(await db.database.select().from(schema.channelMessages)).toEqual([]);
    expect(await db.database.select().from(schema.activityReviews)).toEqual([]);
  });

  it('waits for the evening, does not catch up the next day, and skips an off household', async () => {
    await seed();
    arm();
    const morning = new Date('2026-06-02T15:30:00.000Z');
    expect((await runMidActivityAskSweep(db.database, morning, openDeps())).tooSoon).toBe(1);
    const nextDay = new Date('2026-06-03T16:00:00.000Z');
    expect((await runMidActivityAskSweep(db.database, nextDay, openDeps())).pastWindow).toBe(1);

    await db.exec('truncate table families, users cascade');
    await seed({ cadence: 'off' });
    expect((await runMidActivityAskSweep(db.database, NOW, openDeps())).preferenceOff).toBe(1);

    await db.exec('truncate table families, users cascade');
    await seed({ activityKey: 'swim-parent-tot' });
    expect((await runMidActivityAskSweep(db.database, NOW, openDeps())).noSubject).toBe(1);
  });

  it('does not ask about a teenager, and does not ask a second activity the same sweep', async () => {
    await seed({ dateOfBirth: '2010-01-01' });
    arm();
    expect((await runMidActivityAskSweep(db.database, NOW, openDeps())).teenScoped).toBe(1);

    await db.exec('truncate table families, users cascade');
    const first = await seed();
    const [secondCandidate] = await db.database
      .insert(schema.familyActivityHistory)
      .values({
        familyId: first.familyId,
        title: 'Saturday library',
        kind: 'class',
        summary: 'another weekly class',
        source: 'web_grounded',
        confidence: 0.8,
        placeId: 'places/library',
      })
      .returning({ id: schema.familyActivityHistory.id });
    await db.database.insert(schema.authorizedSignupOffers).values({
      familyId: first.familyId,
      childId: first.childId,
      parentUserId: first.parentUserId,
      activityKey: secondCandidate?.id as string,
      registrationUrl: 'https://example.com/other',
      sessions: weeklySessions(8),
      status: 'completed',
    });

    const result = await runMidActivityAskSweep(db.database, NOW, openDeps());
    expect(result.oneAtATime).toBe(1);
    expect(result.queued).toBe(1);
  });

  it('treats a sent ask as already asked, so the next tick does not queue another', async () => {
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
      createdAt: new Date('2026-06-02T22:30:00.000Z'),
    });
    arm();

    const result = await runMidActivityAskSweep(db.database, NOW, openDeps());
    expect(result.alreadyAsked).toBe(1);
    expect(result.queued).toBe(0);
  });

  it('queues an ask for a Hale-placed calendar plan, keyed to the recommendation that placed it', async () => {
    const seeded = await seed({ offerStatus: 'pending' });
    const [signal] = await db.database
      .insert(schema.events)
      .values({
        familyId: seeded.familyId,
        source: 'test',
        eventType: 'signal.test',
        dedupHash: `mid-plan-${seeded.familyId}`,
        status: 'reviewed',
      })
      .returning({ id: schema.events.id });
    const [action] = await db.database
      .insert(schema.actions)
      .values({
        eventId: signal?.id as string,
        familyId: seeded.familyId,
        actionType: 'calendar_add',
        payload: {
          title: 'Parent and tot swim',
          startsAt: new Date(FIRST).toISOString(),
          sourceRef: { table: 'family_activity_history', id: seeded.candidateId },
        },
      })
      .returning({ id: schema.actions.id });
    const [event] = await db.database
      .insert(schema.familyEvents)
      .values({
        familyId: seeded.familyId,
        childId: seeded.childId,
        title: 'Parent and tot swim',
        startsAt: new Date(FIRST),
        endsAt: new Date(FIRST + 45 * 60_000),
        source: 'placement',
        placedByActionId: action?.id as string,
      })
      .returning({ id: schema.familyEvents.id });
    arm();

    const result = await runMidActivityAskSweep(db.database, NOW, openDeps());
    expect(result.queued).toBe(1);
    const [row] = await db.database.select().from(schema.proactiveCandidates);
    expect(row?.dedupeKey).toBe(
      midActivityStartDedupeKey({
        start: 'plan',
        occurrence: event?.id as string,
        candidateId: seeded.candidateId,
      }),
    );
    expect(row?.why).toContain('start=plan');

    // A sensitive placement is never asked about: its title must not reach the writer.
    await db.exec('delete from proactive_candidates');
    await db.database
      .update(schema.familyEvents)
      .set({ sensitive: true })
      .where(eq(schema.familyEvents.id, event?.id as string));
    const privateRun = await runMidActivityAskSweep(db.database, NOW, openDeps());
    expect(privateRun.queued).toBe(0);
    expect(privateRun.teenScoped).toBe(1);
  });

  it('holds a parent-said signup until the evening after its first session', async () => {
    const seeded = await seed({ offerStatus: 'pending' });
    arm();
    const said = new Date('2026-06-01T20:00:00.000Z');
    const tool = noteActivitySignupTool({
      database: db.database,
      familyId: seeded.familyId,
      parentUserId: seeded.parentUserId,
      now: said,
      timeZone: async () => 'America/Toronto',
      offeredThisTurn: () => [
        {
          title: 'Parent and tot swim',
          venue: '',
          candidateId: seeded.candidateId,
          placeId: PLACE,
          civicVenueId: null,
        },
      ],
    });
    const out = await tool.handler(
      { title: 'Parent and tot swim', date: '2026-06-02', time: '11:00' },
      {} as never,
    );
    expect(out).toEqual({ noted: true });
    const [row] = await db.database.select().from(schema.proactiveCandidates);
    expect(row?.status).toBe('held');
    expect(row?.holdUntil).toEqual(new Date('2026-06-02T22:00:00.000Z'));
    expect(row?.worthlessAfter).toEqual(new Date('2026-06-03T12:00:00.000Z'));
    expect(row?.dedupeKey).toContain(seeded.candidateId);
    // Said again: one ask, not two.
    expect(
      await queueSaidSignupAsk(db.database, {
        familyId: seeded.familyId,
        parentUserId: seeded.parentUserId,
        title: 'Parent and tot swim',
        firstSessionStartsAt: new Date(FIRST),
        firstSessionEndsAt: null,
        candidateId: seeded.candidateId,
        timeZone: 'America/Toronto',
        now: said,
      }),
    ).toBe('duplicate');
  });
});

describe('the mid-activity reply changes the next find', () => {
  it('a reply to the queued ask floats that place in the next search_village read', async () => {
    const seeded = await seed();
    arm();
    await runMidActivityAskSweep(db.database, NOW, openDeps());
    const [candidate] = await db.database.select().from(schema.proactiveCandidates);
    // The decider sends the queued ask: the ledger row carries the candidate's keys.
    await db.database.insert(schema.channelMessages).values({
      familyId: seeded.familyId,
      parentUserId: seeded.parentUserId,
      channel: 'sms',
      direction: 'out',
      category: 'activity_followup',
      templateKey: candidate?.templateKey as string,
      dedupeKey: candidate?.dedupeKey as string,
      status: 'sent',
      createdAt: new Date('2026-06-02T23:05:00.000Z'),
    });
    await db.database.insert(schema.channelMessages).values({
      familyId: seeded.familyId,
      parentUserId: seeded.parentUserId,
      channel: 'sms',
      direction: 'in',
      category: 'reply',
      status: 'delivered',
      body: 'She loved it, pool was cold though',
      createdAt: new Date('2026-06-02T23:20:00.000Z'),
    });

    const pick = (name: string, placeId: string) => ({
      name,
      sourceName: name,
      source: 'web' as const,
      sourceUrl: `https://example.com/${placeId}`,
      ageFit: 'ages 2-5',
      when: 'Saturdays',
      price: 'Free',
      placeId,
    });
    const finder = {
      find: vi.fn().mockResolvedValue({
        found: true,
        picks: [pick('Library story time', 'places/library'), pick('Parent and tot swim', PLACE)],
      }),
    };
    const { searchVillageTool } = await import('~/lib/coach/tools');
    const search = async () => {
      const out = (await searchVillageTool(db.database, undefined, finder).handler({}, {
        familyId: seeded.familyId,
      } as never)) as { candidates: { title: string }[] };
      return out.candidates.map((row) => row.title);
    };
    const before = await search();

    const result = await runMidActivityAnswerPass(db.database, {
      verdict: reader(WORTH_IT),
      now: new Date('2026-06-02T23:40:00.000Z'),
    });
    expect(result.recorded).toBe(1);

    const after = await search();
    expect(before[0]).toBe('Library story time');
    expect(after[0]).toBe('Parent and tot swim');
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
