import { type Database, schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FIRST_REPLY_ACTION_LINE_ENV } from '~/lib/channel/intake/action-line';
import { YEAR_OPEN_LEAD } from '~/lib/channel/intake/year-open';
import {
  FakeExtractor,
  FakeIdentityAsk,
  FakeIntentReader,
  fakeAckComposer,
  fakeSilentAnswerComposer,
} from '~/lib/channel/intake/fakes';
import { type IntakeDeps, handleInboundSms } from '~/lib/channel/intake/machine';
import { createRadarComposer } from '~/lib/channel/intake/radar';
import { FakeTransport } from '~/lib/channel/intake/transport';
import { MAX_PAYLOAD_SEGMENTS } from '~/lib/channel/intake/radar-voice';
import { smsSegments } from '~/lib/channel/sms-segments';
import { threadProactiveMessage } from '~/lib/channel/thread';
import { defaultOpenQuestionReader } from '~/lib/channel/router/wiring';
import { REGISTRATION_WINDOWS } from '~/lib/registration/registration-windows-data';
import { toRegistrationWindowRow } from '~/lib/registration/registration-windows';
import { FakeRateLimiter } from '~/lib/rate-limit/fake';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { fakeWeather } from '~/lib/weather/open-meteo';

/**
 * A TORONTO PARENT TEXTS WHILE THE CITY'S FALL REGISTRATION IS OPEN.
 *
 * The first reply names the Saturday drop-in this family can actually go to. The
 * registration morning is in the database and is not the text. The action-line flag
 * does not put that date back.
 *
 * WHAT THIS FILE PINS, over real Postgres: the civic projection writing `access` and
 * `when_label`, and the first reply carrying the Saturday session rather than the
 * open-now registration sentence.
 */

const TZ = 'America/Toronto';
const APP_KEY = Buffer.alloc(32, 7).toString('base64');
const PARENT_PHONE = '+14165550190';
/** A downtown Toronto FSA: it resolves to exactly one municipality, so this family gets
 * the RESIDENT morning — which is the one that has already gone. */
const TORONTO_FSA = 'M5V 3A8';
/** Friday 2026-09-18, 10:00 Toronto. Toronto's Fall 2026 resident registration opened on
 * the 15th — three days ago, well inside OPEN_NOW_MAX_AGE_DAYS — and the coming weekend
 * is the 19th and 20th. */
const INTAKE_AT = new Date('2026-09-18T14:00:00.000Z');

/** The real seed row's own page, read out of the dataset rather than pasted, so the
 * assertion is about what a family is actually sent. */
const TORONTO_FALL_2026 = REGISTRATION_WINDOWS.find(
  (seed) =>
    seed.municipality === 'toronto' &&
    seed.programDomain === 'rec_program' &&
    seed.cycleLabel === 'Fall 2026',
);
if (!TORONTO_FALL_2026) throw new Error('fixture drift: the Toronto Fall 2026 seed row is gone');
const CITY_PAGE = TORONTO_FALL_2026.sourceUrl;

describe('the first reply says what to do about the find', () => {
  let db: TestDb;
  let database: Database;

  beforeEach(async () => {
    db = await createTestDb();
    database = db.database;
    vi.stubEnv('APP_ENCRYPTION_KEY', APP_KEY);

    await database
      .insert(schema.registrationWindows)
      .values(toRegistrationWindowRow(TORONTO_FALL_2026) as never);

    // A real EarlyON centre with a Saturday drop-in, which is what makes the pick a
    // civic row carrying an access mode and a time of its own.
    const [venue] = await database
      .insert(schema.civicVenues)
      .values({
        system: 'earlyon_toronto',
        externalId: 'loc-1',
        kind: 'earlyon_centre',
        name: 'Queen West EarlyON',
        address: '100 Queen St W',
        city: 'Toronto',
        lat: 43.65,
        lng: -79.39,
        sourceUrl: 'https://open.toronto.ca/dataset/earlyon-child-and-family-centres/',
      })
      .returning({ id: schema.civicVenues.id });

    await database.insert(schema.civicSessions).values({
      venueId: (venue as { id: string }).id,
      externalId: 'loc-1-sat-0930',
      title: 'Saturday family drop-in',
      recurrence: 'weekly',
      dayOfWeek: 6,
      startMinute: 9 * 60 + 30,
      endMinute: 11 * 60,
      ageMinMonths: 0,
      ageMaxMonths: 71,
      isFree: true,
      // The fact the projection used to throw away entirely.
      registrationRequired: false,
      extraction: 'structured',
      confidence: 1,
      sourceUrl: 'https://www.toronto.ca/community-people/children-parenting/earlyon/',
    });

    // The OTHER access mode, on a weekday so it cannot win the weekend pick. Its only
    // job is to make the projection's write of `access` measurable: with one seeded
    // session the insert could hard-code the mode it happens to want and every gate
    // here would stay green.
    await database.insert(schema.civicSessions).values({
      venueId: (venue as { id: string }).id,
      externalId: 'loc-1-wed-1000',
      title: 'Wednesday baby time',
      recurrence: 'weekly',
      dayOfWeek: 3,
      startMinute: 10 * 60,
      endMinute: 11 * 60,
      ageMinMonths: 0,
      ageMaxMonths: 71,
      isFree: true,
      registrationRequired: true,
      extraction: 'structured',
      confidence: 1,
      sourceUrl: 'https://www.toronto.ca/community-people/children-parenting/earlyon/',
    });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await db.close();
  });

  /** The REAL machine, the REAL civic projection, the REAL radar — a fake wire, a fake
   * extractor (rule #8: what it pulls out of real words is an eval's job) and no model. */
  function deps(transport: FakeTransport): IntakeDeps {
    return {
      transport,
      threadMessage: threadProactiveMessage,
      openQuestions: (db2, input) => defaultOpenQuestionReader().open(db2, input),
      extractor: new FakeExtractor([
        { children: [{ name: 'Maya', ageMonths: 30, agePrecision: 'months' }], postalCode: TORONTO_FSA },
      ]),
      intentReader: new FakeIntentReader([
        { intent: 'assent', verbatim: 'yes', interpretation: 'a clear yes' },
      ]),
      radar: createRadarComposer({
        database,
        weather: fakeWeather([]),
        // Rule #8's documented first-class outcome: no model in the path at all.
        client: null,
        now: () => INTAKE_AT,
        timeZone: TZ,
      }),
      ackComposer: fakeAckComposer,
      answerComposer: fakeSilentAnswerComposer,
      identityAsk: new FakeIdentityAsk(),
      // `seedCivic` is DELIBERATELY not injected: the real projectCivicCandidates runs,
      // so this journey pins the write of `access`/`when_label` and not a stand-in.
      resolveCenter: async () => null,
      discoveryTrigger: () => {},
      limiter: new FakeRateLimiter(() => INTAKE_AT.getTime()),
      now: INTAKE_AT,
    };
  }

  let inboundSeq = 0;

  async function arrive(): Promise<{ familyId: string; radarBody: string }> {
    const transport = new FakeTransport();
    const intakeDeps = deps(transport);
    const text = (body: string) => {
      inboundSeq += 1;
      return handleInboundSms(
        database,
        transport.inbound(PARENT_PHONE, body, { providerId: `SM-in-${inboundSeq}` }),
        intakeDeps,
      );
    };

    await text('Hi');
    const outcome = await text('Maya is 30 months, M5V 3A8');
    if (outcome.status !== 'provisioned') {
      throw new Error(`fixture drift: intake ended at ${outcome.status}`);
    }
    const radarBody = transport.sent.map((s) => s.body).find((b) => b.includes(YEAR_OPEN_LEAD));
    if (radarBody === undefined) throw new Error('fixture drift: no radar message was sent');
    return { familyId: outcome.familyId, radarBody };
  }

  it('sends the Saturday drop-in, not the registration morning', async () => {
    vi.stubEnv(FIRST_REPLY_ACTION_LINE_ENV, 'true');
    const { familyId, radarBody } = await arrive();

    // The projection really wrote the two columns — otherwise the pick below would be
    // 'unknown' and this whole journey would pass by saying nothing.
    const persisted = await database
      .select({
        title: schema.villageCandidates.title,
        access: schema.villageCandidates.access,
        whenLabel: schema.villageCandidates.whenLabel,
        source: schema.villageCandidates.source,
      })
      .from(schema.villageCandidates)
      .where(eq(schema.villageCandidates.familyId, familyId));
    // BOTH modes, out of the same insert: a hard-coded `access` on the write passes a
    // one-session seed whichever value it hard-codes, so the two are asserted together.
    expect(persisted.find((row) => row.title === 'Saturday family drop-in')).toMatchObject({
      access: 'drop_in',
      whenLabel: '9:30 a.m.-11:00 a.m.',
      source: 'civic_registry',
    });
    expect(persisted.find((row) => row.title === 'Wednesday baby time')).toMatchObject({
      access: 'register_at_venue',
      whenLabel: '10:00 a.m.-11:00 a.m.',
      source: 'civic_registry',
    });

    expect(radarBody).toContain('Saturday family drop-in');
    expect(radarBody).toContain(YEAR_OPEN_LEAD);
    expect(radarBody).not.toContain('Toronto Fall 2026 registration opened Sep 15, 7:00 a.m.');
    expect(radarBody).not.toContain(CITY_PAGE);
    expect(radarBody).not.toContain('Want me to keep an eye');
    expect(smsSegments(radarBody)).toBeLessThanOrEqual(MAX_PAYLOAD_SEGMENTS);
    expect(radarBody).not.toContain('not posted yet');
    expect(radarBody).not.toContain('no registration date coming up');
    expect(radarBody).not.toContain('already opened');
    for (const claim of ['still room', 'spots', 'fills up', 'sign up']) {
      expect(radarBody.toLowerCase()).not.toContain(claim);
    }
  });

  /**
   * THE DARK HALF. With the flag unset the URL is held — and R10 says the town and the
   * date survive that, because everything except the link ships unflagged and nothing
   * Hale states correctly today may be lost to a rung that did not render.
   */
  it('still names the Saturday drop-in with the action-line flag unset', async () => {
    const { radarBody } = await arrive();

    expect(radarBody).toContain('Saturday family drop-in');
    expect(radarBody).not.toContain('Toronto Fall 2026 registration opened Sep 15, 7:00 a.m.');
    expect(radarBody).not.toContain(CITY_PAGE);
    expect(radarBody).not.toContain('Want me to keep an eye');
    expect(smsSegments(radarBody)).toBeLessThanOrEqual(MAX_PAYLOAD_SEGMENTS);
  });
});
