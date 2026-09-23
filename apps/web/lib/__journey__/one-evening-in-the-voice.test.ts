import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CHECK_IN_ANCHOR_ENABLED_ENV,
  type EveningCheckInDeps,
  defaultEveningCheckInDeps,
  runEveningCheckInSweep,
} from '~/lib/channel/checkin/sweep';
import { CHECK_IN_ASK_TEMPLATE_KEY } from '~/lib/channel/checkin/copy';
import { eveningCheckInQuestion, handleEveningCheckInReply } from '~/lib/channel/checkin/reply';
import { PRIVATE_EVENT_WHAT } from '~/lib/channel/coach/tools';
import { F14_ENABLED_ENV } from '~/lib/channel/f14';
import { OPT_OUT_LINE, withOptOut } from '~/lib/channel/opt-out';
import { buildOutboundGatePorts } from '~/lib/channel/outbound-gate';
import { isGsm7, smsSegments } from '~/lib/channel/sms-segments';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { bareYesNoQuestions } from '~/lib/testing/pool-copy';

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
 *   · the anchored ask on the wire is the VIL-366 sentence, both nights. The day pool
 *     still rotates when there is no activity to name. This fixture names swim, so both
 *     evenings are that one locked sentence on purpose.
 *   · rule 11 holds on the WIRE BODY, opt-out and all — not on a pool member in
 *     isolation. A parent answering "no" to a question a bare no answers turns the
 *     evening off for good, and what they answer is what arrived on the phone.
 *   · the teen is absent on BOTH evenings, with the under-13's own activity named in the
 *     same breath as the positive control. An absence assertion fails open; a silent lane
 *     would satisfy it twice over.
 *   · the second evening's answer is filed against the SECOND evening. The anchored form
 *     keeps template key checkin:ask precisely so this holds, and nothing else in the
 *     suite reads two asks from one household.
 *
 * VIL-366 replaced the anchored rotation with one sentence. A composer that paraphrased
 * it, or that fell through to the day pool while swim was nameable, fails the equality
 * against that sentence. The unanchored rotation stays in copy.test.ts.
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
async function alignLedgerToSendClock(): Promise<void> {
  await db.exec('update channel_messages set created_at = sent_at where sent_at is not null');
}

/**
 * The real deps, minus only what a test cannot have: the phone network, and the consent
 * and enrolment state the gate reads from tables this journey does not seed. Selection,
 * the children read, the ACTIVITY read, the composer, the dedupe key, the ledger write,
 * the audit row and the prefs write are all production code — including the frequency cap,
 * whose twenty-hour window two consecutive evenings have to clear.
 */
function prodDeps(sent: Array<{ to: string; body: string }>): EveningCheckInDeps {
  return {
    ...defaultEveningCheckInDeps(),
    buildGate: (database) => ({
      ...buildOutboundGatePorts(database),
      channelEnrolled: async () => true,
      watchConsentGranted: async () => true,
      proactiveSentSince: async () => false,
    }),
    readinessStanding: async () => null,
    resolveSendablePhone: async () => '+14165550100',
    transport: {
      send: async (input) => {
        sent.push(input);
        return { providerMessageId: `prov-${sent.length}` };
      },
    },
  };
}

describe('two evenings in the voice', () => {
  it('names her swim both nights with the locked sentence, and never the teenager', async () => {
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

    const sent: Array<{ to: string; body: string }> = [];
    const first = await runEveningCheckInSweep(db.database, prodDeps(sent), EVENING_ONE);
    expect({ asked: first.asked, anchored: first.anchor.anchored }).toEqual({
      asked: 1,
      anchored: 1,
    });
    await alignLedgerToSendClock();

    const second = await runEveningCheckInSweep(db.database, prodDeps(sent), EVENING_TWO);
    expect({ asked: second.asked, anchored: second.anchor.anchored }).toEqual({
      asked: 1,
      anchored: 1,
    });
    await alignLedgerToSendClock();

    expect(sent).toHaveLength(2);
    const [nightOne, nightTwo] = sent.map((message) => message.body);

    // VIL-366. Same class both nights, so the same locked sentence both nights. The gate
    // stub reports no earlier proactive send, so both carry the full opt-out.
    const locked = withOptOut('How did swim go? One line is plenty.', 'full');
    expect(nightOne).toBe(locked);
    expect(nightTwo).toBe(locked);

    for (const body of [nightOne, nightTwo] as string[]) {
      // One GSM-7 segment WITH the CASL line on it — measured on what went out, because
      // the opt-out is part of the message and not a footnote to it.
      expect(body, body).toContain(OPT_OUT_LINE);
      expect(isGsm7(body), body).toBe(true);
      expect(smsSegments(body), body).toBe(1);
      // Her own class, named. The positive control for every absence below: a lane that
      // anchored nothing would satisfy all of them.
      expect(body, body).toContain('swim');
      // The fourteen-year-old, on both evenings: not her brother's name, not his
      // appointment, and no trace that a private row existed at all.
      expect(body, body).not.toContain('Noah');
      expect(body, body).not.toContain('orthodontist');
      expect(body, body).not.toContain(PRIVATE_EVENT_WHAT);
      // RULE 11 on the wire. "no" is a whole-string cadence keyword read before anything
      // else looks at the reply, so a question a bare no answers is a question that
      // unsubscribes the household when it is answered honestly.
      expect(bareYesNoQuestions(body), body).toEqual([]);
    }

    const rows = await db.database
      .select()
      .from(schema.channelMessages)
      .where(eq(schema.channelMessages.familyId, familyId));
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.templateKey).toBe(CHECK_IN_ASK_TEMPLATE_KEY);

    // THE ANSWER LANDS ON THE RIGHT EVENING. The anchored form keeps template key
    // checkin:ask for exactly this: a second key would leave the newest ask unfindable,
    // and the ladder would count a silence for a question the parent had answered.
    const answeredAt = new Date(EVENING_TWO.getTime() + 80 * 60_000);
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
