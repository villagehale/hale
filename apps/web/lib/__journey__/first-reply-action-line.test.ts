import { type Database, schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FIRST_REPLY_ACTION_LINE_ENV } from '~/lib/channel/intake/action-line';
import { PRIVACY_URL } from '~/lib/legal-links';
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
 * On main this family is told their season has gone: the matcher drops the window whose
 * open instant has passed, `latestPastCycle` picks the same row back up, and the reply
 * reads "registration already opened Sep 15 - the next dates are not posted yet." The
 * city's page is live, it is in the row as a NOT NULL hand-verified `source_url`, and
 * nothing ever printed it.
 *
 * WHAT ONLY THIS FILE PINS, over real Postgres and the deployed code: the civic
 * projection writing `access` and `when_label`, `readCandidates` selecting them,
 * `stillOpenCycle` scanning the same rows the matcher just discarded, the tense on the
 * one absence rung, the block budget spending its mapping clause, and the action line
 * carrying the city's own URL — each produced by the step before it rather than
 * stipulated. Every unit test below this is a stipulation of exactly one of those.
 *
 * THE VOICE CLIENT IS NULL, and that satisfies rule #8 rather than dodging it: no model
 * is in the path at all, which is the documented first-class outcome
 * (`voiceFallback: 'no_client'`), and what the composed voice says about this shape is
 * the eval's subject, not this file's.
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
    // The radar is the message that carries the watch offer; the greeting and the
    // contact card are the others.
    const radarBody = transport.sent.map((s) => s.body).find((b) => b.includes(PRIVACY_URL));
    if (radarBody === undefined) throw new Error('fixture drift: no radar message was sent');
    return { familyId: outcome.familyId, radarBody };
  }

  it('sends the open-now sentence and the city page, in one sendable text', async () => {
    vi.stubEnv(FIRST_REPLY_ACTION_LINE_ENV, 'true');
    const { familyId, radarBody } = await arrive();

    // The projection really wrote the two columns — otherwise the pick below would be
    // 'unknown' and this whole journey would pass by saying nothing.
    const [candidate] = await database
      .select({
        access: schema.villageCandidates.access,
        whenLabel: schema.villageCandidates.whenLabel,
        source: schema.villageCandidates.source,
      })
      .from(schema.villageCandidates)
      .where(eq(schema.villageCandidates.familyId, familyId));
    expect(candidate).toMatchObject({
      access: 'drop_in',
      whenLabel: '9:30 a.m.-11:00 a.m.',
      source: 'civic_registry',
    });

    // The tense: their town, their cycle, and the morning it opened.
    expect(radarBody).toContain('Toronto Fall 2026 registration opened Sep 15, 7:00 a.m.');
    // The page, byte-identical to the hand-verified row.
    expect(radarBody).toContain(`The page is here: ${CITY_PAGE}`);
    expect(radarBody).toContain(PRIVACY_URL);
    expect(smsSegments(radarBody)).toBeLessThanOrEqual(MAX_PAYLOAD_SEGMENTS);

    // The two sentences that ARE the defect. Their absence is what this whole build is.
    expect(radarBody).not.toContain('not posted yet');
    expect(radarBody).not.toContain('no registration date coming up');
    expect(radarBody).not.toContain('already opened');
    // R7 — Hale has not read that page and says nothing about what is left on it.
    for (const claim of ['still room', 'spots', 'fills up', 'sign up']) {
      expect(radarBody.toLowerCase()).not.toContain(claim);
    }
  });

  /**
   * THE DARK HALF. With the flag unset the URL is held — and R10 says the town and the
   * date survive that, because everything except the link ships unflagged and nothing
   * Hale states correctly today may be lost to a rung that did not render.
   */
  it('still names the town and the date with the flag unset, and sends no link', async () => {
    const { radarBody } = await arrive();

    expect(radarBody).toContain('Toronto Fall 2026 registration opened Sep 15, 7:00 a.m.');
    expect(radarBody).not.toContain(CITY_PAGE);
    // The privacy URL is the consent moment's and is not the action line's to hold.
    expect(radarBody).toContain(PRIVACY_URL);
    expect(smsSegments(radarBody)).toBeLessThanOrEqual(MAX_PAYLOAD_SEGMENTS);
    expect(radarBody).not.toContain('not posted yet');
    expect(radarBody).not.toContain('no registration date coming up');
  });
});
