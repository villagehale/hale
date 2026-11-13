import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { postalOwnCityQuotes } from '~/lib/registration/city/context';
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
 * town has a reading off its own page: the answer is that reading, through the real cache
 * and context, never a second live search that could name another date. The model's read
 * of the ask and the search are stipulated; the reading is the real store's.
 */

const NOW = new Date('2026-11-12T15:00:00Z');
const MARKHAM_PAGE = 'https://www.markham.ca/recreation/registration';
const RESIDENTS = '2027 Winter Registration for residents: December 1, 2026, at 6:30 AM';
const NON_RESIDENTS = '2027 Winter Registration for non-residents: December 2, 2026, at 6:30 AM';

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

async function markhamOnFile(): Promise<void> {
  const reading: VerifiedRegistrationReading = {
    sourceUrl: MARKHAM_PAGE,
    checkedAt: NOW,
    reader: 'ai',
    status: 'verified',
    timeZone: 'America/Toronto',
    dates: [
      date('resident_open', '2026-12-01', RESIDENTS),
      date('general_open', '2026-12-02', NON_RESIDENTS),
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

describe('the signup door answers from the own-city reading the family is told', () => {
  const ask = {
    parentWords: 'when does winter rec registration open?',
    pendingAsk: 'cold start ask (test fixture)',
    children: [],
    postalCode: 'L3P',
  };

  it("says the town page's own dates, not a second search's", async () => {
    await markhamOnFile();
    const { client, searches } = programDatesClient();
    const composer = createIntakeAnswerComposer(client, (postal, now) =>
      postalOwnCityQuotes(db.database, postal, now),
    );

    const outcome = await composer.compose(ask);

    expect(outcome).toEqual({ status: 'answered', body: `${RESIDENTS}. ${NON_RESIDENTS}.` });
    expect(searches()).toBe(0);
  });

  it('answers from the reading for any program-dates wording, not only one the hand matcher takes', async () => {
    await markhamOnFile();
    const { client, searches } = programDatesClient();
    const composer = createIntakeAnswerComposer(client, (postal, now) =>
      postalOwnCityQuotes(db.database, postal, now),
    );

    const outcome = await composer.compose({
      ...ask,
      parentWords: 'when do winter programs open for sign up in my town?',
    });

    expect(outcome).toEqual({ status: 'answered', body: `${RESIDENTS}. ${NON_RESIDENTS}.` });
    expect(searches()).toBe(0);
  });

  it('answers a town outside the GTA from its own reading', async () => {
    const quote = 'Winter Session 2027 Registration Date: December 16, 2026 at 8 a.m.';
    await onFile(
      { city: 'Greater Sudbury', provinceOrState: 'Ontario', country: 'Canada', district: null },
      SUDBURY_PAGE,
      'America/Toronto',
      [{ kind: 'unclassified_open', date: '2026-12-16', time: '08:00', evidence: [quote] }],
    );
    const { client, searches } = programDatesClient();
    const composer = createIntakeAnswerComposer(client, (postal, now) =>
      postalOwnCityQuotes(db.database, postal, now),
    );

    const outcome = await composer.compose({
      ...ask,
      postalCode: 'P3A 1A1',
      parentWords: 'when does winter swim registration open?',
    });

    expect(outcome).toEqual({ status: 'answered', body: quote });
    expect(searches()).toBe(0);
  });

  it("answers a US ZIP from its town's reading, with both mornings: a ZIP is not residency", async () => {
    const residents = 'Winter registration for City residents: December 1, 2026 at 9 a.m.';
    const everyone = 'Non-residents: December 8, 2026 at 9 a.m.';
    await onFile(
      { city: 'Fairfax', provinceOrState: 'Virginia', country: 'United States', district: null },
      'https://www.fairfaxva.gov/recreation/registration',
      'America/New_York',
      [
        { kind: 'resident_open', date: '2026-12-01', time: '09:00', evidence: [residents] },
        { kind: 'general_open', date: '2026-12-08', time: '09:00', evidence: [everyone] },
      ],
    );
    const { client, searches } = programDatesClient();
    const composer = createIntakeAnswerComposer(client, (postal, now) =>
      postalOwnCityQuotes(db.database, postal, now),
    );

    const outcome = await composer.compose({ ...ask, postalCode: '22030' });

    expect(outcome).toEqual({ status: 'answered', body: `${residents} ${everyone}` });
    expect(searches()).toBe(0);
  });

  it('searches as before for a town with no reading on file (positive control)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client, searches } = programDatesClient();
    const composer = createIntakeAnswerComposer(client, (postal, now) =>
      postalOwnCityQuotes(db.database, postal, now),
    );
    // No reading: the hand dataset answers a Markham date question first, so ask the
    // model's path directly with a question that dataset does not take.
    const outcome = await composer.compose({
      ...ask,
      parentWords: 'when do winter programs open for sign up in my town?',
    });
    expect(searches()).toBe(1);
    expect(outcome).toMatchObject({ status: 'answered' });
    if (outcome.status === 'answered') expect(outcome.body).toContain('December 5');
  });
});
