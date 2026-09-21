import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { activityFollowupAskOpen } from '~/lib/channel/followup/ask-open';
import {
  type FollowupSweepDeps,
  defaultFollowupSweepDeps,
  runFollowupSweep,
} from '~/lib/channel/followup/run';
import { FakeTransport } from '~/lib/channel/intake/transport';
import { nearbySaidFor } from '~/lib/channel/coach/runtime';
import { toSmsReply } from '~/lib/channel/coach/reply';
import type { OfferedCandidate } from '~/lib/coach/tools';
import {
  ACTIVITY_REVIEWS_ENABLED_ENV,
  runReviewCapture,
} from '~/lib/reviews/capture';
import { ACTIVITY_REVIEWS_SURFACE_ENV } from '~/lib/reviews/aggregate';
import type { VerdictOutcome, VerdictReader } from '~/lib/reviews/verdict';
import { createTestDb, type TestDb } from '~/lib/testing/pglite';

/**
 * FEEDBACK THAT REACHES THE NEXT PARENT — the whole path, over one database.
 *
 * One household is offered a civic drop-in over text, it goes on their calendar carrying
 * the candidate that placed it, the REAL follow-up sweep asks how it went, the REAL
 * capture pass reads the reply, and — once two more households have answered about the
 * same venue — a FOURTH family's coach reply carries a sentence it could not have carried
 * before. The negative half is asserted first and on the same data: at two families the
 * reply says nothing at all.
 *
 * WHAT IS REAL HERE. The sweep's own selection and its `recordSend`, so the template key
 * and the dedupe key that bind the ask to its placement are the production ones rather
 * than two strings this file made up; `activityFollowupAskOpen`; the subject resolver;
 * the table and its unique index; the aggregate; `nearbySaidFor`, which is the production
 * `nearbySaid` port; and `toSmsReply`.
 *
 * WHAT IS FAKED, AND WHY IT IS ALLOWED. The Anthropic CLIENT, in two places. The
 * follow-up's composer writes a question whose quality is `eval:followup-voice`'s
 * business, and the verdict extractor's judgement is `eval:activity-verdict`'s — the
 * reply and the verdict below are the `two-clauses` fixture from that corpus, verbatim,
 * so what stands in for the model here is what the model was measured saying (rule #8:
 * the judgement is an eval, never an assertion against a mock). The outbound gate and
 * the transport are faked because consent, quiet hours and Twilio each have their own
 * tests and none of them is this path.
 */

const TZ = 'America/Toronto';
/** Halton Hills — a municipality `matchAreaKey` resolves to one bucket, so "near you"
 * means a town rather than an FSA. */
const AREA = 'L7G';
/** The activity itself: Saturday morning, two days before the sweep runs. */
const PLACED_AT = new Date('2026-09-12T14:00:00.000Z');
/** Monday 10:00 Toronto — outside quiet hours, inside the 1–4 day ask window. */
const ASK_AT = new Date('2026-09-14T14:00:00.000Z');

/** The registry venue three households are about to agree on. */
const VENUE_ID = '9f1c2b6a-7d31-4c2e-9a54-0a2b3c4d5e6f';
const TITLE = 'Georgetown EarlyON drop-in';
/** The branch itself — what the three households actually answered about, and so what
 * the clause names (founder decision 2: venue grain, silent about the programme). */
const VENUE = 'Georgetown Library';

/**
 * `activity-verdict-fixtures.mjs#two-clauses`, verbatim — the reply and the answer the
 * eval measured Claude giving for it.
 */
const PARENT_REPLY = 'Loved it, parking was a nightmare though.';
const MEASURED_VERDICT: VerdictOutcome = {
  status: 'read',
  verdict: 'worth_it',
  tags: ['hard_parking'],
  tagsDropped: 0,
};

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

interface Household {
  familyId: string;
  parentUserId: string;
  childId: string;
}

async function seedHousehold(slug: string): Promise<Household> {
  const [family] = await db.database
    .insert(schema.families)
    .values({
      displayName: `${slug} household`,
      provinceOrState: 'ON',
      areaCoarse: AREA,
      onboardingStage: 'sms_active',
    })
    .returning({ id: schema.families.id });
  const familyId = family?.id as string;
  const [user] = await db.database
    .insert(schema.users)
    .values({ externalAuthId: `sms:${slug}`, name: slug, timezone: TZ })
    .returning({ id: schema.users.id });
  const parentUserId = user?.id as string;
  await db.database
    .insert(schema.familyMembers)
    .values({ familyId, userId: parentUserId, role: 'primary_parent' });
  const [child] = await db.database
    .insert(schema.children)
    .values({ familyId, name: 'Mia', dateOfBirth: '2023-03-01' })
    .returning({ id: schema.children.id });
  return { familyId, parentUserId, childId: child?.id as string };
}

/** A civic candidate carrying its registry venue, and the placement the texted add made
 * from it — the `sourceRef` shape `propose_calendar_add` now writes. */
async function seedTextedPlacement(home: Household): Promise<string> {
  const [candidate] = await db.database
    .insert(schema.villageCandidates)
    .values({
      familyId: home.familyId,
      title: TITLE,
      kind: 'drop_in',
      summary: 'Free indoor drop-in for under-sixes.',
      source: 'civic_registry',
      confidence: 0.9,
      placeId: null,
      civicVenueId: VENUE_ID,
      // Already retired by the next discovery run, which is the ordinary state of a
      // candidate by the time the ask goes out.
      supersededAt: new Date('2026-09-13T00:00:00.000Z'),
    })
    .returning({ id: schema.villageCandidates.id });

  const [event] = await db.database
    .insert(schema.events)
    .values({
      familyId: home.familyId,
      source: 'channel',
      eventType: 'channel_message',
      dedupHash: `journey-${home.familyId}`,
    })
    .returning({ id: schema.events.id });
  const [action] = await db.database
    .insert(schema.actions)
    .values({
      eventId: event?.id as string,
      familyId: home.familyId,
      actionType: 'calendar_add',
      userVisibleState: 'autonomous',
      payload: {
        title: TITLE,
        startsAt: PLACED_AT.toISOString(),
        sourceRef: { table: 'village_candidates', id: candidate?.id as string },
      },
    })
    .returning({ id: schema.actions.id });

  const [placement] = await db.database
    .insert(schema.familyEvents)
    .values({
      familyId: home.familyId,
      childId: home.childId,
      title: TITLE,
      startsAt: PLACED_AT,
      source: 'placement',
      placedByActionId: action?.id as string,
    })
    .returning({ id: schema.familyEvents.id });
  return placement?.id as string;
}

/** The sweep, with only the model, the gate and the wire replaced. */
function sweepDeps(home: Household): FollowupSweepDeps {
  const base = defaultFollowupSweepDeps();
  return {
    ...base,
    buildGate: () => ({
      channelEnrolled: async () => true,
      watchConsentGranted: async () => true,
      countProactiveSends: async () => 0,
      proactiveSentSince: async () => true,
      parentTimeZone: async () => TZ,
    }),
    resolveSendablePhone: async () => '+14165550100',
    voice: {
      compose: async () => ({
        status: 'composed' as const,
        body: `How did ${TITLE} go on Saturday?`,
      }),
    },
    transport: new FakeTransport(),
    // The intros half of the sweep is a different feature with its own journey.
    loadDueIntros: async () => [],
    discoverableUserIds: async () => new Set<string>(),
    // The family is the one seeded above; the selection query itself is exercised by
    // asking it for that family rather than every row pglite happens to hold.
    selectFamilies: async () =>
      (await base.selectFamilies(db.database, ASK_AT)).filter(
        (family) => family.familyId === home.familyId,
      ),
  };
}

function reader(outcome: VerdictOutcome): VerdictReader {
  return { read: async () => outcome };
}

/** One more household's answer about the same venue, written the way the capture pass
 * writes it. */
async function anotherFamilySays(
  slug: string,
  verdict: 'worth_it' | 'not_worth_it',
): Promise<void> {
  const home = await seedHousehold(slug);
  const [message] = await db.database
    .insert(schema.channelMessages)
    .values({
      familyId: home.familyId,
      parentUserId: home.parentUserId,
      channel: 'sms',
      direction: 'in',
      category: 'reply',
      status: 'delivered',
      body: PARENT_REPLY,
    })
    .returning({ id: schema.channelMessages.id });
  await db.database.insert(schema.activityReviews).values({
    familyId: home.familyId,
    sourceMessageId: message?.id as string,
    subjectSource: 'civic_venue',
    subjectRef: VENUE_ID,
    areaKey: 'halton_hills',
    childAgeBand: 'toddler',
    verdict,
    tags: [],
  });
}

/** What `search_village` reported to the turn — the offer ledger, not the sentences. */
const OFFERED: OfferedCandidate[] = [
  { title: TITLE, venue: VENUE, candidateId: 'cand-next', placeId: null, civicVenueId: VENUE_ID },
];

describe('a review reaches the next parent', () => {
  it('goes from one texted placement to a sentence a fourth family reads', async () => {
    vi.stubEnv('FOLLOWUP_ASKS_ENABLED', 'true');
    vi.stubEnv(ACTIVITY_REVIEWS_ENABLED_ENV, 'true');
    vi.stubEnv(ACTIVITY_REVIEWS_SURFACE_ENV, 'true');

    // ── 1. the placement, and the ask the REAL sweep sends about it ──────────
    const home = await seedHousehold('first');
    const familyEventId = await seedTextedPlacement(home);

    const swept = await runFollowupSweep(db.database, sweepDeps(home), ASK_AT);
    expect(swept.activityAsked).toBe(1);

    // THE SEAM THE CAPTURE PASS DEPENDS ON and no unit test can pin: the sweep's own
    // template key and dedupe key, written by the production `recordSend`. The key is
    // what says WHICH placement Hale asked about, and it is the only thing on the row
    // that does.
    const [askRow] = await db.database
      .select({
        id: schema.channelMessages.id,
        createdAt: schema.channelMessages.createdAt,
        dedupeKey: schema.channelMessages.dedupeKey,
        templateKey: schema.channelMessages.templateKey,
      })
      .from(schema.channelMessages)
      .where(eq(schema.channelMessages.direction, 'out'));
    expect(askRow?.templateKey).toBe('followup:activity');
    expect(askRow?.dedupeKey).toBe(`followup:activity:${familyEventId}`);

    // The rest of the timeline hangs off the row's OWN stamp rather than a constant:
    // `created_at` is the database's clock, and the ledger reader keys on it.
    const askedAt = askRow?.createdAt as Date;
    const repliedAt = new Date(askedAt.getTime() + 20 * 60_000);
    const capturedAt = new Date(askedAt.getTime() + 60 * 60_000);

    const ask = await activityFollowupAskOpen(db.database, {
      familyId: home.familyId,
      parentUserId: home.parentUserId,
      now: repliedAt,
    });
    expect(ask?.id).toBe(askRow?.id);

    // ── 2. the parent answers, and the REAL capture pass reads it ────────────
    await db.database.insert(schema.channelMessages).values({
      familyId: home.familyId,
      parentUserId: home.parentUserId,
      channel: 'sms',
      direction: 'in',
      category: 'reply',
      status: 'delivered',
      body: PARENT_REPLY,
      createdAt: repliedAt,
    });

    // AND HALE ANSWERED THEM, five seconds later — every reply that falls through to
    // the coach gets one (`route.ts`), so this row is present on the real timeline of
    // every captured review. The tick an hour later still reads the answer, because the
    // ledger is read as of the reply rather than as of the tick.
    await db.database.insert(schema.channelMessages).values({
      familyId: home.familyId,
      parentUserId: home.parentUserId,
      channel: 'sms',
      direction: 'out',
      category: 'reply',
      status: 'queued',
      createdAt: new Date(repliedAt.getTime() + 5_000),
    });

    const captured = await runReviewCapture(db.database, {
      askOpen: activityFollowupAskOpen,
      verdict: reader(MEASURED_VERDICT),
      now: capturedAt,
    });
    expect(captured.recorded).toBe(1);

    const [stored] = await db.database.select().from(schema.activityReviews);
    expect({
      subjectSource: stored?.subjectSource,
      subjectRef: stored?.subjectRef,
      areaKey: stored?.areaKey,
      childAgeBand: stored?.childAgeBand,
      verdict: stored?.verdict,
    }).toEqual({
      subjectSource: 'civic_venue',
      subjectRef: VENUE_ID,
      areaKey: 'halton_hills',
      childAgeBand: 'toddler',
      verdict: 'worth_it',
    });

    // ── 3. TWO households have answered. The next parent hears nothing. ──────
    await anotherFamilySays('second', 'worth_it');
    const beforeThird = await nearbySaidFor(db.database, home.familyId, OFFERED);
    expect(beforeThird).toBeNull();

    const quietReply = toSmsReply(`${TITLE} runs Saturday mornings.`, {
      children: [],
      now: capturedAt,
      nearby: beforeThird ?? undefined,
    });
    expect(quietReply).toBe(`${TITLE} runs Saturday mornings.`);

    // ── 4. THREE households. The clause exists, and the reply carries it. ────
    await anotherFamilySays('third', 'worth_it');
    const nearby = await nearbySaidFor(db.database, home.familyId, OFFERED);
    expect(nearby?.clause).toBe(`3 families near you say ${VENUE} is worth it.`);

    const nextParentsReply = toSmsReply(`${TITLE} runs Saturday mornings.`, {
      children: [],
      now: capturedAt,
      nearby: nearby ?? undefined,
    });
    expect(nextParentsReply).toBe(
      `${TITLE} runs Saturday mornings. 3 families near you say ${VENUE} is worth it.`,
    );

    // ── 5. and it goes when a household does (PIPEDA, no recompute anywhere) ─
    await db.database.delete(schema.families).where(eq(schema.families.id, home.familyId));
    expect(await nearbySaidFor(db.database, (await seedHousehold('fourth')).familyId, OFFERED)).toBeNull();
  });
});
