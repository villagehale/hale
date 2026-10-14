import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CHECK_IN_ASK_TEMPLATE_KEY } from '~/lib/channel/checkin/copy';
import { eveningCheckInQuestion, handleEveningCheckInReply } from '~/lib/channel/checkin/reply';
import {
  CHECK_IN_ANCHOR_ENABLED_ENV,
  type EveningCheckInDeps,
  defaultEveningCheckInDeps,
  runEveningCheckInSweep,
} from '~/lib/channel/checkin/sweep';
import { PRIVATE_EVENT_WHAT } from '~/lib/channel/coach/tools';
import { F14_ENABLED_ENV } from '~/lib/channel/f14';
import { buildOutboundGatePorts } from '~/lib/channel/outbound-gate';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';

/**
 * TWO EVENINGS IN A ROW, IN THE VOICE — the whole of V5 on the one message a household
 * reads more often than any other.
 *
 * Each half of this is pinned somewhere already: the pools in checkin/copy.test.ts, the
 * rotation in variant.test.ts, the six subtractions in checkin/sweep.pglite.test.ts, the
 * standing question in checkin/reply.pglite.test.ts. What none of them can see is the
 * SECOND evening: the teen still absent, the answer filed against Monday, and the
 * anchored ask still the locked sentence after the occasion has advanced.
 *
 * So the pins here are the ones that only exist across two nights and one reply:
 *
 *   · both evenings queue swim as a fact, and never the teenager. The writer speaks.
 *     There is no locked sentence and no keyword.
 *   · the second evening's answer is filed against the SECOND evening, once a sent
 *     checkin:ask row exists. The sweep itself does not open the question.
 */

/** 20:17 Toronto on Sunday 2026-07-05 — inside the evening slot. */
const EVENING_ONE = new Date('2026-07-06T00:17:00.000Z');
/** The same slot the next local evening, Monday 2026-07-06. */
const EVENING_TWO = new Date(EVENING_ONE.getTime() + 24 * 3_600_000);
/** 16:00 local each day: the under-13's own class, already over by the time Hale asks. */
const SWIM_ONE = new Date('2026-07-05T20:00:00.000Z');
const SWIM_TWO = new Date('2026-07-06T20:00:00.000Z');
/** 17:00 local each day: the fourteen-year-old's, LATER than the swim on purpose — the
 * anchor takes the latest nameable row, so a teen's row must be subtracted rather than
 * merely out-sorted. */
const TEEN_ONE = new Date('2026-07-05T21:00:00.000Z');
const TEEN_TWO = new Date('2026-07-06T21:00:00.000Z');
const TZ = 'America/Toronto';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
  process.env[F14_ENABLED_ENV] = 'true';
  process.env[CHECK_IN_ANCHOR_ENABLED_ENV] = 'true';
});

afterAll(async () => {
  delete process.env[F14_ENABLED_ENV];
  delete process.env[CHECK_IN_ANCHOR_ENABLED_ENV];
  await db.close();
});

/**
 * Postgres stamps `created_at` off the real wall clock while the sweep runs on an injected
 * one, so both evenings' ledger rows land within milliseconds of each other and the
 * standing-question reader — which orders by `created_at` — cannot tell them apart. In
 * production the two clocks are the same instant. This puts them back together, and it is
 * what makes "filed against the SECOND evening" a real question rather than a coin flip.
 */
function prodDeps(): EveningCheckInDeps {
  return {
    ...defaultEveningCheckInDeps(),
    buildGate: (database) => ({
      ...buildOutboundGatePorts(database),
      channelEnrolled: async () => true,
      watchConsentGranted: async () => true,
      proactiveSentSince: async () => false,
      countProactiveSends: async () => 0,
    }),
    readinessStanding: async () => null,
  };
}

describe('two evenings in the voice', () => {
  it('queues her swim both nights as a fact, and never the teenager', async () => {
    const [family] = await db.database
      .insert(schema.families)
      .values({ displayName: 'Ana + kids', provinceOrState: 'ON', onboardingStage: 'sms_active' })
      .returning({ id: schema.families.id });
    const familyId = family?.id as string;
    const [parent] = await db.database
      .insert(schema.users)
      .values({ externalAuthId: `sms:${familyId}`, name: 'Ana', timezone: TZ })
      .returning({ id: schema.users.id });
    const parentUserId = parent?.id as string;
    await db.database
      .insert(schema.familyMembers)
      .values({ familyId, userId: parentUserId, role: 'primary_parent' });

    const [mia] = await db.database
      .insert(schema.children)
      .values({ familyId, name: 'Mia', dateOfBirth: '2022-03-10' })
      .returning({ id: schema.children.id });
    const [noah] = await db.database
      .insert(schema.children)
      .values({ familyId, name: 'Noah', dateOfBirth: '2012-02-01' })
      .returning({ id: schema.children.id });

    for (const [startsAt, childId] of [
      [SWIM_ONE, mia?.id as string],
      [SWIM_TWO, mia?.id as string],
    ] as const) {
      await db.database
        .insert(schema.familyEvents)
        .values({ familyId, childId, title: 'swim', startsAt, source: 'parent' });
    }
    for (const startsAt of [TEEN_ONE, TEEN_TWO]) {
      await db.database.insert(schema.familyEvents).values({
        familyId,
        childId: noah?.id as string,
        title: 'orthodontist',
        startsAt,
        source: 'parent',
      });
    }

    // Asked yesterday, so tonight is the pooled question and not the once-in-a-lifetime
    // first ask — the one message in this lane that deliberately never varies.
    await db.database.insert(schema.familyCheckInPrefs).values({
      familyId,
      lastAskedAt: new Date(EVENING_ONE.getTime() - 24 * 3_600_000),
    });

    const first = await runEveningCheckInSweep(db.database, prodDeps(), EVENING_ONE);
    expect({ queued: first.queued, anchored: first.anchor.anchored }).toEqual({
      queued: 1,
      anchored: 1,
    });

    const second = await runEveningCheckInSweep(db.database, prodDeps(), EVENING_TWO);
    expect({ queued: second.queued, anchored: second.anchor.anchored }).toEqual({
      queued: 1,
      anchored: 1,
    });

    const offers = await db.database
      .select()
      .from(schema.proactiveCandidates)
      .where(eq(schema.proactiveCandidates.familyId, familyId));
    expect(offers).toHaveLength(2);
    for (const offer of offers) {
      expect(offer.what).toContain('swim');
      expect(offer.what).toContain('Mia');
      expect(offer.what).not.toContain('Noah');
      expect(offer.what).not.toContain('orthodontist');
      expect(offer.what).not.toContain(PRIVATE_EVENT_WHAT);
      expect(offer.what).not.toMatch(/\b(?:reply|text|send)\s+[A-Z]{2,}\b/);
      expect(offer.templateKey).toBe(CHECK_IN_ASK_TEMPLATE_KEY);
    }

    // The sweep does not open a question. A sent row does, and the answer files
    // against the evening that row names.
    const answeredAt = new Date(EVENING_TWO.getTime() + 80 * 60_000);
    await db.database.insert(schema.channelMessages).values({
      familyId,
      parentUserId,
      channel: 'sms',
      direction: 'out',
      category: 'evening_check_in',
      templateKey: CHECK_IN_ASK_TEMPLATE_KEY,
      status: 'sent',
      dedupeKey: `evening_check_in:${familyId}:2026-07-06`,
      createdAt: EVENING_TWO,
      sentAt: EVENING_TWO,
    });
    const standing = await eveningCheckInQuestion(db.database, {
      familyId,
      parentUserId,
      now: answeredAt,
    });
    expect(standing).not.toBeNull();
    expect(standing?.askedAt.getTime()).toBe(EVENING_TWO.getTime());

    const [inbound] = await db.database
      .insert(schema.channelMessages)
      .values({
        familyId,
        parentUserId,
        channel: 'sms',
        direction: 'in',
        category: 'reply',
        status: 'delivered',
        body: 'she loved it, went straight to sleep after',
        createdAt: answeredAt,
      })
      .returning({ id: schema.channelMessages.id });

    const outcome = await handleEveningCheckInReply(db.database, {
      familyId,
      parentUserId,
      body: 'she loved it, went straight to sleep after',
      askedAt: standing?.askedAt as Date,
      timeZone: TZ,
      inboundChannelMessageId: inbound?.id as string,
      now: answeredAt,
    });
    expect(outcome.status).toBe('note_stored');

    const notes = await db.database
      .select()
      .from(schema.familyCheckInNotes)
      .where(eq(schema.familyCheckInNotes.familyId, familyId));
    expect(notes).toHaveLength(1);
    // Monday, not Sunday: filed under the evening that asked, not the evening before it.
    expect(notes[0]?.notedOn).toBe('2026-07-06');
  });
});
