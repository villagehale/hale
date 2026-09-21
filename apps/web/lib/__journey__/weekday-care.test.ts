import { schema } from '@hale/db';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  WEEKDAY_CARE_ENABLED_ENV,
  loadWeekdayCare,
  loadWeekdayCareContext,
  recordWeekdayCare,
} from '~/lib/care/weekday';
import { CIVIC_SOURCE } from '~/lib/civic/project';
import { INTAKE_RADAR_WEEKEND_PICK_TEMPLATE_KEY } from '~/lib/channel/intake/radar';
import { readCandidates } from '~/lib/channel/intake/radar';
import { FakeTransport } from '~/lib/channel/intake/transport';
import {
  type FollowupSweepDeps,
  FOLLOWUP_ASKS_ENABLED_ENV,
  defaultFollowupSweepDeps,
  runFollowupSweep,
} from '~/lib/channel/followup/run';
import type { OutboundGatePorts } from '~/lib/channel/outbound-gate';
import { type NudgeRunDeps, defaultNudgeRunDeps, runNudgeCron } from '~/lib/channel/nudge/run';
import { channelRouterDeps } from '~/lib/channel/router/wiring';
import { readWeekdayCare } from '~/lib/channel/weekday-care/reply';
import { loadAgentContext } from '~/lib/coach/context';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';

/**
 * THE WEEKDAY-CARE ARC, end to end, over real Postgres and the real readers.
 *
 * Hale sends a weekend find. Days later it says "those are all weekend finds" and asks
 * the one question. The parent answers in their own words; the fact lands; the week
 * after, the EarlyON drop-in that was in this family's feed all along finally goes out.
 * Then the other branch: a parent who answers "at Little Sprouts" is asked once, days
 * later, how it is going.
 *
 * WHAT ONLY THIS FILE PINS. Every piece has its own unit test against a fake, and every
 * one of those is a stipulation: the ask's precondition stipulates a weekend find was
 * sent, the find's stipulates a fact exists, the follow-up's stipulates a daycare
 * answer. Here each one is produced by the step before it, through the SQL that will
 * run in production — `readCandidates` with its `source` column, `loadWeekdayCareContext`
 * with both its ledger reads, `writeFact`'s supersede, `loadDaycareSubjects` reaching
 * back past it.
 *
 * WHAT IS NOT DRIVEN HERE: `routeChannelMessage`. GATE 2c-bis's ORDERING — that the
 * write lands before the coach composes and never claims the turn — is pinned in
 * lib/channel/router/route.test.ts over the router's own harness. What runs here is the
 * same composition that gate calls, `weekdayCareAnswerTarget` from the production
 * wiring, so the reader and the same-door rule are the real ones.
 */

const TZ = 'America/Toronto';
/** NO FSA on purpose. Ontario's health checkpoints are region-gated and outrank both
 * weekday legs, so a family with an area would spend every tick of this journey on a
 * vaccine-record reminder. The checkpoint ladder has its own journey test; this one is
 * about the two rungs below it. */
const AREA = null;
/** 10:00 Toronto on Friday 2026-08-07 — inside the nudge's local send hour. */
const FRIDAY = new Date('2026-08-07T14:00:00.000Z');
/** The Tuesday after it, in the family's own zone. */
const TUESDAY_KEY = '2026-08-11';
const PHONE = '+15551230000';

let db: TestDb;
let familyId: string;
let parentUserId: string;
let toddlerId: string;
let teenId: string;

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
      displayName: 'Ana + kids',
      provinceOrState: 'ON',
      onboardingStage: 'sms_active',
      createdAt: new Date('2026-07-01T00:00:00.000Z'),
    })
    .returning({ id: schema.families.id });
  familyId = family?.id as string;

  const [user] = await db.database
    .insert(schema.users)
    .values({ externalAuthId: 'sms:journey', name: 'Ana', timezone: TZ })
    .returning({ id: schema.users.id });
  parentUserId = user?.id as string;
  await db.database
    .insert(schema.familyMembers)
    .values({ familyId, userId: parentUserId, role: 'primary_parent' });

  // A two-year-old and a fifteen-year-old. The teen exists so that every send below is
  // also an assertion that she is never named (rule #1).
  const [toddler] = await db.database
    .insert(schema.children)
    .values({ familyId, name: 'Mia', dateOfBirth: '2024-06-01' })
    .returning({ id: schema.children.id });
  toddlerId = toddler?.id as string;
  const [teen] = await db.database
    .insert(schema.children)
    .values({ familyId, name: 'Ava', dateOfBirth: '2011-03-04' })
    .returning({ id: schema.children.id });
  teenId = teen?.id as string;

  // THE FEED THE WEEKEND RULE THROWS AWAY: one civic Tuesday morning, already in this
  // family's rows, projected by the weekly sweep exactly as production writes them.
  await db.database.insert(schema.villageCandidates).values({
    familyId,
    title: 'EarlyON drop-in',
    kind: 'drop_in',
    summary: 'Free drop-in at Armour Heights - 9:30 a.m.-11:00 a.m.',
    source: CIVIC_SOURCE,
    runType: 'civic',
    eventDate: TUESDAY_KEY,
    venueName: 'Armour Heights',
    priceLevel: 'free',
    indoorOutdoor: 'indoor',
    confidence: 0.9,
    discoveredAt: new Date('2026-08-03T15:57:00.000Z'),
  });
});

const openGate = (): OutboundGatePorts => ({
  channelEnrolled: async () => true,
  watchConsentGranted: async () => true,
  countProactiveSends: async () => 0,
  proactiveSentSince: async () => false,
  parentTimeZone: async () => TZ,
});

/**
 * Production deps, with the OUTSIDE WORLD replaced and every read left real. The four
 * overrides are the phone network, the weather API, the model and the consent gate;
 * `selectFamilies` and `loadRecipients` are overridden because both join
 * `parent_channels`, which needs an encryption key this journey has no use for.
 */
function nudgeDeps(transport: FakeTransport): NudgeRunDeps {
  return {
    ...defaultNudgeRunDeps(),
    selectFamilies: async () => [
      { familyId, parentUserId, areaCoarse: AREA, timeZone: TZ, provisionedAt: new Date('2026-07-01T00:00:00.000Z') },
    ],
    loadRecipients: async () => [{ parentUserId, timeZone: TZ, role: 'primary_parent' as const }],
    resolveSendablePhone: async () => PHONE,
    weather: { getDailyOutlook: async () => [] },
    buildGate: openGate,
    transport,
    // No model: the deterministic render IS the message for the ask, and for the find it
    // is the grounded floor. Either way the words below are Hale's own.
    client: null,
  };
}

function followupDeps(transport: FakeTransport): FollowupSweepDeps {
  return {
    ...defaultFollowupSweepDeps(),
    selectFamilies: async () => [{ familyId, parentUserId }],
    resolveSendablePhone: async () => PHONE,
    buildGate: openGate,
    transport,
    voice: {
      // The composer is proved against real cached Claude in
      // apps/worker/evals/run-followup-voice-eval.mjs (rule #8). What this journey owns
      // is whether the sweep reaches it with the right subject at the right time.
      async compose(request) {
        if (request.kind !== 'daycare') throw new Error('journey: unexpected follow-up kind');
        return {
          status: 'composed' as const,
          body:
            request.provider === null
              ? 'How is daycare going? No pressure to reply.'
              : `How is ${request.provider} going? No pressure to reply.`,
        };
      },
    },
  };
}

/** The intake radar's first text, when it carried a weekend pick — the D23 anchor. */
async function seedWeekendFind(): Promise<void> {
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
}

/** The parent's own words, as the router would have recorded them. */
async function inbound(body: string, at: Date): Promise<string> {
  const [row] = await db.database
    .insert(schema.channelMessages)
    .values({
      familyId,
      parentUserId,
      channel: 'sms',
      direction: 'in',
      category: 'reply',
      status: 'delivered',
      body,
      createdAt: at,
    })
    .returning({ id: schema.channelMessages.id });
  return row?.id as string;
}

/**
 * GATE 2c-bis's own composition: the production `weekdayCareAnswerTarget`, the grammar,
 * and the one writer. Exactly what the router calls, minus the router.
 */
async function answer(body: string, at: Date): Promise<'recorded' | 'not_recorded'> {
  const inboundChannelMessageId = await inbound(body, at);
  const target = await channelRouterDeps(db.database).weekdayCareAnswerTarget(db.database, {
    familyId,
    parentUserId,
    inboundChannelMessageId,
    now: at,
  });
  if (target.status !== 'open') return 'not_recorded';
  const reading = readWeekdayCare(body);
  if (reading.status !== 'read') return 'not_recorded';
  await recordWeekdayCare(db.database, {
    familyId,
    parentUserId,
    childId: target.childId,
    care: reading.care,
    provider: reading.provider,
    now: at,
  });
  return 'recorded';
}

async function outbound(templateKey: string) {
  return db.database
    .select()
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.familyId, familyId),
        eq(schema.channelMessages.templateKey, templateKey),
      ),
    );
}

describe('the weekday-care arc', () => {
  it('asks, hears the answer, and then sends the weekday find it promised', async () => {
    await seedWeekendFind();

    // ── the ask ───────────────────────────────────────────────────────────────
    const askTransport = new FakeTransport();
    const asked = await runNudgeCron(db.database, nudgeDeps(askTransport), FRIDAY);

    expect(asked.sent).toBe(1);
    const askBody = askTransport.sent[0]?.body ?? '';
    expect(askBody).toContain('Those are all weekend finds. Is Mia home with you during the week');
    // The fifteen-year-old is never named, on this send or any other (rule #1).
    expect(askBody).not.toContain('Ava');
    const [askRow] = await outbound('proactive_nudge:weekday_care');
    expect(askRow?.dedupeKey).toBe(`nudge:${familyId}:weekday_care:${toddlerId}:${parentUserId}`);

    // ── the answer, in the parent's own words ─────────────────────────────────
    const answeredAt = new Date(FRIDAY.getTime() + 20 * 60_000);
    expect(await answer("she's home with me during the week", answeredAt)).toBe('recorded');

    expect(await loadWeekdayCare(db.database, familyId)).toEqual([
      {
        factId: expect.any(String),
        childId: toddlerId,
        care: 'home',
        provider: null,
        validFrom: answeredAt,
      },
    ]);
    // The coach's next turn already knows, with no new code and no reply template.
    const context = await loadAgentContext(
      {
        familyId,
        question: 'anything on this week?',
        intent: null,
        focusedChildId: toddlerId,
        transcript: [],
        sourceNote: null,
      },
      db.database,
      answeredAt,
    );
    expect(JSON.stringify(context.memoryFacts)).toContain('weekday_care');

    // ── the payoff, the following week ────────────────────────────────────────
    // 10:00 Toronto on MONDAY 2026-08-10 — the tick before the Tuesday session, not a
    // second Friday. The day matters: {@link TUESDAY_KEY} is 08-11, and any tick after
    // it would be refused as `weekday_date_past` rather than reaching the find at all.
    // The nudge's own 7-day cap is not what this date is buying — `openGate` stubs
    // `countProactiveSends` to 0, so the cap plays no part in this journey either way.
    // What the find needed was the ANSWER: the Tuesday session was in this family's feed
    // the whole time and the weekend rule was discarding it.
    const theMondayAfter = new Date('2026-08-10T14:00:00.000Z');
    const findTransport = new FakeTransport();
    const found = await runNudgeCron(db.database, nudgeDeps(findTransport), theMondayAfter);

    expect(found.sent).toBe(1);
    const findBody = findTransport.sent[0]?.body ?? '';
    expect(findBody).toContain('Tuesday');
    expect(findBody).toContain('EarlyON drop-in');
    expect(findBody).toContain('Armour Heights');
    expect(findBody).not.toContain('Ava');
    expect((await outbound('proactive_nudge:weekday_dropin'))).toHaveLength(1);
  });

  it('never asks the same household twice', async () => {
    await seedWeekendFind();
    const transport = new FakeTransport();

    await runNudgeCron(db.database, nudgeDeps(transport), FRIDAY);
    // A week later, with the question unanswered: the ledger row is the permanent
    // answer to "have we asked?", so the reason is `already_asked` rather than a
    // dedupe collision.
    const again = await runNudgeCron(
      db.database,
      nudgeDeps(transport),
      new Date('2026-08-14T14:00:00.000Z'),
    );

    expect(again.sent).toBe(0);
    expect(again.skips.already_asked).toBe(1);
  });

  it('asks nobody it has not sent a weekend find to (D23)', async () => {
    // No anchor row at all: Hale has nothing it could truthfully say "those" about.
    const transport = new FakeTransport();

    const result = await runNudgeCron(db.database, nudgeDeps(transport), FRIDAY);

    expect(result.sent).toBe(0);
    expect(result.skips.no_weekend_find_sent).toBe(1);
    expect(transport.sent).toEqual([]);
  });

  it('files a daycare answer and comes back once, days later, to ask how it is going', async () => {
    await seedWeekendFind();
    await runNudgeCron(db.database, nudgeDeps(new FakeTransport()), FRIDAY);

    const answeredAt = new Date(FRIDAY.getTime() + 20 * 60_000);
    expect(await answer("she's at Little Sprouts now", answeredAt)).toBe('recorded');
    expect(await loadWeekdayCare(db.database, familyId)).toEqual([
      {
        factId: expect.any(String),
        childId: toddlerId,
        care: 'daycare',
        provider: 'Little Sprouts',
        validFrom: answeredAt,
      },
    ]);

    // The find is OFF for this household now — the same context read, a different answer.
    const context = await loadWeekdayCareContext(db.database, familyId);
    expect(context.askedBefore).toBe(true);
    expect(context.stated[0]?.care).toBe('daycare');

    vi.stubEnv(FOLLOWUP_ASKS_ENABLED_ENV, 'true');
    const followupTransport = new FakeTransport();
    // Five days after they said it: inside the 3-to-10-day window.
    const fiveDaysOn = new Date(answeredAt.getTime() + 5 * 24 * 3_600_000);
    const swept = await runFollowupSweep(db.database, followupDeps(followupTransport), fiveDaysOn);

    expect(swept.daycareAsked).toBe(1);
    expect(followupTransport.sent[0]?.body).toContain('Little Sprouts');
    const [followupRow] = await outbound('followup:daycare');
    expect(followupRow?.dedupeKey).toBe(`followup:daycare:${toddlerId}`);

    // ONCE PER CHILD, EVER.
    const again = await runFollowupSweep(
      db.database,
      followupDeps(new FakeTransport()),
      new Date(fiveDaysOn.getTime() + 86_400_000),
    );
    expect(again.daycareAsked).toBe(0);
    expect(again.skipped.already_claimed).toBe(1);
  });

  it('does not ask how daycare is going once the answer has moved on', async () => {
    await seedWeekendFind();
    await runNudgeCron(db.database, nudgeDeps(new FakeTransport()), FRIDAY);

    const saidDaycare = new Date(FRIDAY.getTime() + 20 * 60_000);
    expect(await answer("she's at Little Sprouts now", saidDaycare)).toBe('recorded');
    // Two days later they say the opposite. `writeFact` supersedes, and the follow-up
    // window is still open on the first answer.
    await recordWeekdayCare(db.database, {
      familyId,
      parentUserId,
      childId: toddlerId,
      care: 'home',
      provider: null,
      now: new Date(saidDaycare.getTime() + 2 * 24 * 3_600_000),
    });

    vi.stubEnv(FOLLOWUP_ASKS_ENABLED_ENV, 'true');
    const transport = new FakeTransport();
    const swept = await runFollowupSweep(
      db.database,
      followupDeps(transport),
      new Date(saidDaycare.getTime() + 5 * 24 * 3_600_000),
    );

    expect(swept.daycareAsked).toBe(0);
    expect(swept.skipped.care_changed).toBe(1);
    expect(transport.sent).toEqual([]);
  });

  /**
   * THE SAME REFUSAL WHEN THE WORD DID NOT CHANGE — the shape a comparison on the care
   * VALUE could not see, over the real readers rather than a pair of fakes. A family
   * that MOVES daycare says "daycare" twice, and the send that came out of that named
   * the place the parent had just said their child left, spending the once-per-child
   * key on it forever.
   *
   * The second half is what makes the refusal a deferral rather than a loss: the key is
   * unspent, so the newer answer is asked about when ITS own window opens.
   */
  it('does not ask about the daycare a family has left, and asks about the new one later', async () => {
    await seedWeekendFind();
    await runNudgeCron(db.database, nudgeDeps(new FakeTransport()), FRIDAY);

    const saidFirst = new Date(FRIDAY.getTime() + 20 * 60_000);
    expect(await answer("she's at Little Sprouts now", saidFirst)).toBe('recorded');
    const movedAt = new Date(saidFirst.getTime() + 2 * 24 * 3_600_000);
    await recordWeekdayCare(db.database, {
      familyId,
      parentUserId,
      childId: toddlerId,
      care: 'daycare',
      provider: 'Bright Horizons',
      now: movedAt,
    });

    vi.stubEnv(FOLLOWUP_ASKS_ENABLED_ENV, 'true');
    // Day 4: the FIRST answer's window is open and the second's is not.
    const early = new FakeTransport();
    const swept = await runFollowupSweep(
      db.database,
      followupDeps(early),
      new Date(saidFirst.getTime() + 4 * 24 * 3_600_000),
    );

    expect(swept.daycareAsked).toBe(0);
    expect(swept.skipped.care_changed).toBe(1);
    expect(early.sent).toEqual([]);

    // Day 6 from the move: the second answer's own window is open, and the key it needs
    // was never spent.
    const later = new FakeTransport();
    const after = await runFollowupSweep(
      db.database,
      followupDeps(later),
      new Date(movedAt.getTime() + 6 * 24 * 3_600_000),
    );

    expect(after.daycareAsked).toBe(1);
    expect(later.sent[0]?.body).toContain('Bright Horizons');
    expect(later.sent[0]?.body).not.toContain('Little Sprouts');
  });

  it('keeps every claim it makes about the session on a row it can point at', async () => {
    // The whole weekday branch rests on `village_candidates.source`, and the reader is
    // the only thing that carries it off the row. If the column stopped being selected,
    // the find would refuse forever and nothing else in this file would notice.
    const candidates = await readCandidates(db.database, familyId);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.source).toBe(CIVIC_SOURCE);
    expect(candidates[0]?.eventDate).toBe(TUESDAY_KEY);

    // ...and the teen holds no fact and no candidate of her own, in either direction.
    const teenFacts = await db.database
      .select()
      .from(schema.familyMemoryFacts)
      .where(
        and(
          eq(schema.familyMemoryFacts.childId, teenId),
          isNull(schema.familyMemoryFacts.validUntil),
        ),
      );
    expect(teenFacts).toEqual([]);
  });
});
