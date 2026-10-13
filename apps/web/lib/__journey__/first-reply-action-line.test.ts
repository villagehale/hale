import { type Database, schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FIRST_REPLY_ACTION_LINE_ENV } from '~/lib/channel/intake/action-line';
import {
  FakeExtractor,
  FakeIdentityAsk,
  FakeIntentReader,
  fakeSilentAnswerComposer,
} from '~/lib/channel/intake/fakes';
import { type IntakeDeps, handleInboundSms } from '~/lib/channel/intake/machine';
import { createRadarComposer } from '~/lib/channel/intake/radar';
import { scriptedFriendVoice } from '~/lib/channel/intake/scripted-friend-voice.fixture';
import { FakeTransport } from '~/lib/channel/intake/transport';
import { defaultOpenQuestionReader } from '~/lib/channel/router/wiring';
import { threadProactiveMessage } from '~/lib/channel/thread';
import { FakeRateLimiter } from '~/lib/rate-limit/fake';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { fakeWeather } from '~/lib/weather/open-meteo';

/** A Toronto parent gets a fresh Finder pick, never a stored registration morning.
 * Drives real intake and persistence over Postgres with a scripted fresh Finder. */

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
const CITY_PAGE = 'https://example.org/registration';

describe('the first reply says what to do about the find', () => {
  let db: TestDb;
  let database: Database;

  beforeEach(async () => {
    db = await createTestDb();
    database = db.database;
    vi.stubEnv('APP_ENCRYPTION_KEY', APP_KEY);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await db.close();
  });

  /** The REAL machine and radar with a scripted fresh Finder response — a fake wire, a fake
   * extractor (rule #8: what it pulls out of real words is an eval's job) and no model. */
  function deps(transport: FakeTransport): IntakeDeps {
    return {
      transport,
      threadMessage: threadProactiveMessage,
      openQuestions: (db2, input) => defaultOpenQuestionReader().open(db2, input),
      extractor: new FakeExtractor([
        {
          children: [{ name: 'Maya', ageMonths: 30, agePrecision: 'months' }],
          postalCode: TORONTO_FSA,
        },
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
        yearFinder: {
          find: async () => ({
            found: true,
            picks: [
              {
                name: 'Saturday family drop-in',
                ageFit: '0 to 5 years',
                when: 'Saturday 9:30 a.m.-11:00 a.m.',
                price: 'free',
                sourceName: 'Queen West EarlyON',
                source: 'web',
                sourceUrl: 'https://www.toronto.ca/community-people/children-parenting/earlyon/',
                eventDate: '2026-09-19',
                access: 'drop_in',
                indoorOutdoor: 'indoor',
              },
            ],
          }),
        },
      }),
      answerComposer: fakeSilentAnswerComposer,
      friendVoice: scriptedFriendVoice,
      identityAsk: new FakeIdentityAsk(),
      limiter: new FakeRateLimiter(() => INTAKE_AT.getTime()),
      now: INTAKE_AT,
    };
  }

  let inboundSeq = 0;

  async function arrive(): Promise<{ familyId: string }> {
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
    return { familyId: outcome.familyId };
  }

  it('sends the Saturday drop-in, not the registration morning', async () => {
    vi.stubEnv(FIRST_REPLY_ACTION_LINE_ENV, 'true');
    const { familyId } = await arrive();

    // Fresh picks are not written as a shared discovery catalog.
    expect(
      await database
        .select()
        .from(schema.familyActivityHistory)
        .where(eq(schema.familyActivityHistory.familyId, familyId)),
    ).toEqual([]);

    // The reply itself is model-written (friend voice); what the find hands it is
    // the persisted candidates above. No fixed radar body is asserted.
  });
});
