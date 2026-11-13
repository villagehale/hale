import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type RecMorningReader, setSharedRecMorningReader } from '~/lib/channel/rec-morning/read';
import { scriptedRecMorningReader } from '~/lib/channel/rec-morning/scripted-reader.fixture';
import { postalOwnCityOpening } from '~/lib/registration/city/context';
import { OWN_CITY_REGISTRATION_ENABLED_ENV } from '~/lib/registration/city/flag';
import { recordCityReading } from '~/lib/registration/city/store';
import type {
  LiveRegistrationDate,
  VerifiedRegistrationReading,
} from '~/lib/registration/live-reading';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { createIntakeAnswerComposer } from './answer';

/**
 * VIL-684 · a parent mid-signup asks when their own town's registration opens, and the
 * town has a reading off its own page: the answer is written from the same line the
 * family is later told (each date with who it is for), through the real cache and
 * context, never a second live search that could name another date. A question about
 * anything else (another town, another season, a club, a closing date) is the search's.
 * The intake model's read of the ask, the rec-morning reader's verdict and the search are
 * stipulated; the reading is the real store's, and the scripted writer restates the facts
 * it is handed.
 */

const NOW = new Date('2026-11-12T15:00:00Z');
const MARKHAM_PAGE = 'https://www.markham.ca/recreation/registration';
const RESIDENTS = '2027 Winter Registration for residents: December 1, 2026, at 6:30 AM';
const NON_RESIDENTS = '2027 Winter Registration for non-residents: December 2, 2026, at 6:30 AM';
const MARKHAM_RESIDENT_LINE =
  'Markham Winter 2027 registration opens Dec 1, 6:30 a.m. for Markham residents; everyone else Dec 2, 6:30 a.m.';
const MARKHAM_IN_DOUBT_LINE =
  'Markham Winter 2027 registration opens Dec 1, 6:30 a.m. if they live in Markham, otherwise Dec 2, 6:30 a.m.';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(() => {
  vi.stubEnv(OWN_CITY_REGISTRATION_ENABLED_ENV, 'true');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(async () => {
  setSharedRecMorningReader(scriptedRecMorningReader);
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await db.exec('truncate table city_registration_readings');
});

const date = (kind: LiveRegistrationDate['kind'], day: string, quote: string) => ({
  kind,
  date: day,
  time: '06:30',
  evidence: [quote],
});

async function markhamOnFile(residents = RESIDENTS, nonResidents = NON_RESIDENTS): Promise<void> {
  const reading: VerifiedRegistrationReading = {
    sourceUrl: MARKHAM_PAGE,
    checkedAt: NOW,
    reader: 'ai',
    status: 'verified',
    timeZone: 'America/Toronto',
    dates: [
      date('resident_open', '2026-12-01', residents),
      date('general_open', '2026-12-02', nonResidents),
    ],
    partialDates: [],
  };
  await recordCityReading(
    db.database,
    { city: 'Markham', provinceOrState: 'Ontario', country: 'Canada', district: null },
    'Winter 2027',
    { status: 'verified', municipality: 'City of Markham', sourceUrl: MARKHAM_PAGE, reading },
    NOW,
  );
}

const SUDBURY_PAGE =
  'https://www.greatersudbury.ca/play/pools/swimming-lessons/program-registration-dates/';

async function onFile(
  place: Parameters<typeof recordCityReading>[1],
  sourceUrl: string,
  timeZone: string,
  dates: LiveRegistrationDate[],
): Promise<void> {
  const reading: VerifiedRegistrationReading = {
    sourceUrl,
    checkedAt: NOW,
    reader: 'ai',
    status: 'verified',
    timeZone,
    dates,
    partialDates: [],
  };
  await recordCityReading(
    db.database,
    place,
    'Winter 2027',
    { status: 'verified', municipality: place.city, sourceUrl, reading },
    NOW,
  );
}

/** The intake model reads the ask as a program date; a live search would name Dec 5. */
function programDatesClient() {
  let searches = 0;
  const client = {
    messages: {
      create: async (req: { tools?: Array<{ type?: string }> }) => {
        if (req.tools?.[0]?.type === 'web_search_20250305') {
          searches += 1;
          return {
            content: [
              { type: 'text', text: 'Markham winter registration opens December 5 at 9:00 a.m.' },
              {
                type: 'web_search_tool_result',
                tool_use_id: 'srvtu_1',
                content: [{ type: 'web_search_result', url: MARKHAM_PAGE, title: 'source' }],
              },
            ],
          };
        }
        return {
          stop_reason: 'end_turn',
          usage: { input_tokens: 0, output_tokens: 0 },
          content: [
            {
              type: 'text',
              text: JSON.stringify({ askKind: 'program_dates', answer: '', returnLine: '' }),
            },
          ],
        };
      },
    },
  } as never;
  return { client, searches: () => searches };
}

/** What the rec-morning reader was handed, and its stipulated verdict. */
function stipulatedReader(reading: 'answers' | 'other' | null) {
  const handed: Array<{ text: string; facts: string }> = [];
  const reader: RecMorningReader = async (input) => {
    handed.push({ text: input.text, facts: input.facts });
    return reading;
  };
  setSharedRecMorningReader(reader);
  return handed;
}

const composerOn = (client: never) =>
  createIntakeAnswerComposer(client, (postal, now) =>
    postalOwnCityOpening(db.database, postal, now),
  );

describe('the signup door answers from the own-city reading the family is told', () => {
  const ask = {
    parentWords: 'when does winter rec registration open?',
    pendingAsk: 'cold start ask (test fixture)',
    children: [],
    postalCode: 'L3P',
  };

  it("writes the family's own line, each date with who it is for, not a second search", async () => {
    await markhamOnFile();
    const handed = stipulatedReader('answers');
    const { client, searches } = programDatesClient();

    const outcome = await composerOn(client).compose(ask);

    expect(outcome).toEqual({ status: 'answered', body: MARKHAM_RESIDENT_LINE });
    expect(handed).toEqual([{ text: ask.parentWords, facts: MARKHAM_RESIDENT_LINE }]);
    expect(searches()).toBe(0);
  });

  it("keeps the condition for a family whose residency is in doubt, even when the page's quotes are bare dates", async () => {
    // The production reader's evidence[0] is often the date alone, with no eligibility.
    await markhamOnFile('December 1, 2026, at 6:30 AM', 'December 2, 2026, at 6:30 AM');
    stipulatedReader('answers');
    const { client, searches } = programDatesClient();

    const outcome = await composerOn(client).compose({ ...ask, postalCode: 'L3T' });

    expect(outcome).toEqual({ status: 'answered', body: MARKHAM_IN_DOUBT_LINE });
    expect(searches()).toBe(0);
  });

  for (const parentWords of [
    'my sister is in Ottawa, when does registration open there?',
    'when does summer camp registration open?',
    'when does Markham Skating Club registration open?',
    'when does winter registration close?',
  ]) {
    it(`leaves a question the own town's opening does not answer to the search: "${parentWords}"`, async () => {
      await markhamOnFile();
      const handed = stipulatedReader('other');
      const { client, searches } = programDatesClient();

      const outcome = await composerOn(client).compose({ ...ask, parentWords });

      // The reader, not a word test, judged it, and was handed the town's own line.
      expect(handed).toEqual([{ text: parentWords, facts: MARKHAM_RESIDENT_LINE }]);
      expect(searches()).toBe(1);
      expect(outcome).toMatchObject({ status: 'answered' });
      if (outcome.status === 'answered') expect(outcome.body).not.toContain('Dec 1');
    });
  }

  it('searches when the read of the question failed, rather than guess the town', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await markhamOnFile();
    stipulatedReader(null);
    const { client, searches } = programDatesClient();

    await composerOn(client).compose(ask);

    expect(searches()).toBe(1);
  });

  it('answers a town outside the GTA from its own reading', async () => {
    const quote = 'Winter Session 2027 Registration Date: December 16, 2026 at 8 a.m.';
    await onFile(
      { city: 'Greater Sudbury', provinceOrState: 'Ontario', country: 'Canada', district: null },
      SUDBURY_PAGE,
      'America/Toronto',
      [{ kind: 'unclassified_open', date: '2026-12-16', time: '08:00', evidence: [quote] }],
    );
    stipulatedReader('answers');
    const { client, searches } = programDatesClient();

    const outcome = await composerOn(client).compose({
      ...ask,
      postalCode: 'P3A 1A1',
      parentWords: 'when does winter swim registration open?',
    });

    expect(outcome).toEqual({
      status: 'answered',
      body: 'Greater Sudbury Winter 2027 registration opens Dec 16, 8:00 a.m.',
    });
    expect(searches()).toBe(0);
  });

  it("answers a US ZIP from its town's reading, with both mornings: a ZIP is not residency", async () => {
    await onFile(
      { city: 'Fairfax', provinceOrState: 'Virginia', country: 'United States', district: null },
      'https://www.fairfaxva.gov/recreation/registration',
      'America/New_York',
      [
        { kind: 'resident_open', date: '2026-12-01', time: '09:00', evidence: ['December 1'] },
        { kind: 'general_open', date: '2026-12-08', time: '09:00', evidence: ['December 8'] },
      ],
    );
    stipulatedReader('answers');
    const { client, searches } = programDatesClient();

    const outcome = await composerOn(client).compose({ ...ask, postalCode: '22030' });

    expect(outcome).toEqual({
      status: 'answered',
      body: 'Fairfax Winter 2027 registration opens Dec 1, 9:00 a.m. if they live in Fairfax, otherwise Dec 8, 9:00 a.m.',
    });
    expect(searches()).toBe(0);
  });

  it('searches as before for a town with no reading on file (positive control)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const handed = stipulatedReader('answers');
    const { client, searches } = programDatesClient();
    // No reading: the hand dataset answers a Markham date question first, so ask the
    // model's path directly with a question that dataset does not take.
    const outcome = await composerOn(client).compose({
      ...ask,
      parentWords: 'when do winter programs open for sign up in my town?',
    });
    expect(handed).toEqual([]);
    expect(searches()).toBe(1);
    expect(outcome).toMatchObject({ status: 'answered' });
    if (outcome.status === 'answered') expect(outcome.body).toContain('December 5');
  });
});
