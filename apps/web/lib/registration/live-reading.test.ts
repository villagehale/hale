import { describe, expect, it } from 'vitest';
import {
  type LiveRegistrationReading,
  type RegistrationReadSource,
  normalizeExtractedRegistration,
  registrationAnchor,
} from './live-reading';
import { registrationDate } from './read';
import type { ExtractedWindow } from './verify-window';

/**
 * The AI path's gate, driven with hand-built extraction answers: a parse-boundary input,
 * not a mocked model. What the model actually returns is the registration-verify eval's
 * job (hard rule #8).
 */

const SOURCE: RegistrationReadSource = {
  sourceUrl: 'https://example.org/registration',
  checkedAt: new Date('2026-10-01T12:00:00Z'),
};

const ZONE = { timeZone: 'America/New_York', timeZoneEvidence: 'Eastern Time' } as const;

function extracted(overrides: Partial<ExtractedWindow>): ExtractedWindow {
  return {
    found: true,
    reason: null,
    cycleOnPage: 'Fall 2026',
    yearEvidence: null,
    evidence: null,
    preview: null,
    residentOpen: null,
    generalOpen: null,
    unclassifiedOpen: null,
    partialDates: [],
    ...ZONE,
    note: null,
    confidence: 0.95,
    ...overrides,
  };
}

function anchors(reading: LiveRegistrationReading): Record<string, string> {
  if (reading.status !== 'verified') throw new Error(`expected verified, got ${reading.status}`);
  return Object.fromEntries(
    reading.dates.map((date) => [date.kind, registrationAnchor(reading, date).toISOString()]),
  );
}

describe('a French page with quoted dates', () => {
  // Every accent DECOMPOSED on the page (as some CMSs emit it) and precomposed in the
  // model's quotes, so the one normalisation of both sides is what makes them meet.
  const PAGE = [
    "Session d'hiver 2027 — Baie-des-Hérons (Nouveau-Brunswick).",
    'Inscription des résidents : lundi 7 décembre 2026 à 18 h 30.',
    'Inscription des non-résidents : vendredi 11 décembre 2026 à 9 h.',
  ]
    .join(' ')
    .normalize('NFD');

  const reading = (residentTime: string) =>
    extracted({
      cycleOnPage: "Session d'hiver 2027",
      evidence: 'Inscription des résidents : lundi 7 décembre 2026 à 18 h 30.',
      yearEvidence: 'lundi 7 décembre 2026',
      residentOpen: {
        quote: 'lundi 7 décembre 2026 à 18 h 30',
        date: '2026-12-07',
        time: residentTime,
      },
      generalOpen: {
        quote: 'vendredi 11 décembre 2026 à 9 h',
        date: '2026-12-11',
        time: '09:00',
      },
      timeZone: 'America/Moncton',
      timeZoneEvidence: 'Nouveau-Brunswick',
    });

  it('verifies in the zone the page names, with each date read from its own quote', () => {
    expect(PAGE).not.toBe(PAGE.normalize('NFC'));
    const result = normalizeExtractedRegistration(reading('18:30'), PAGE, SOURCE);

    expect(result).toMatchObject({
      status: 'verified',
      reader: 'ai',
      timeZone: 'America/Moncton',
      dates: [
        { kind: 'resident_open', date: '2026-12-07', time: '18:30' },
        { kind: 'general_open', date: '2026-12-11', time: '09:00' },
      ],
    });
    expect(anchors(result)).toEqual({
      resident_open: '2026-12-07T22:30:00.000Z',
      general_open: '2026-12-11T13:00:00.000Z',
    });
  });

  it('refuses a time its own quote does not state', () => {
    expect(normalizeExtractedRegistration(reading('19:30'), PAGE, SOURCE)).toMatchObject({
      status: 'unverified',
      reason: 'uncorroborated',
    });
  });
});

describe('eligibility is the slot the model chose; code reads no label', () => {
  const PAGE =
    'Fall 2026. Registration opens August 11, 2026 at 6:30 a.m. Pool hours are Eastern Time.';
  const opening = {
    quote: 'August 11, 2026 at 6:30 a.m.',
    date: '2026-08-11',
    time: '06:30',
  };
  const base = {
    evidence: 'Registration opens August 11, 2026 at 6:30 a.m.',
    yearEvidence: 'August 11, 2026',
  };

  it('keeps a date the model put in general_open as the general opening', () => {
    const result = normalizeExtractedRegistration(
      extracted({ ...base, generalOpen: opening }),
      PAGE,
      SOURCE,
    );

    expect(result).toMatchObject({ status: 'verified', dates: [{ kind: 'general_open' }] });
    expect(registrationDate(result, false)?.date).toBe('2026-08-11');
    expect(anchors(result)).toEqual({ general_open: '2026-08-11T10:30:00.000Z' });
  });

  it('keeps an unclassified opening unclassified, and never offers it as a usable date', () => {
    const result = normalizeExtractedRegistration(
      extracted({ ...base, unclassifiedOpen: opening }),
      PAGE,
      SOURCE,
    );

    expect(result).toMatchObject({
      status: 'verified',
      dates: [{ kind: 'unclassified_open', date: '2026-08-11', time: '06:30' }],
    });
    expect(registrationDate(result, false)).toBeNull();
    expect(registrationDate(result, true)).toBeNull();
  });
});

describe('the zone must be quoted from the page and real', () => {
  const PAGE =
    'Fall 2026. Public registration opens August 11, 2026 at 6:30 a.m. Pool hours are Eastern Time.';
  const reading = (zone: Pick<ExtractedWindow, 'timeZone' | 'timeZoneEvidence'>) =>
    extracted({
      evidence: 'Public registration opens August 11, 2026 at 6:30 a.m.',
      yearEvidence: 'August 11, 2026',
      generalOpen: { quote: 'August 11, 2026 at 6:30 a.m.', date: '2026-08-11', time: '06:30' },
      ...zone,
    });

  it('refuses a zone whose quote is not on the page', () => {
    const result = normalizeExtractedRegistration(
      reading({ timeZone: 'Europe/London', timeZoneEvidence: 'London venue' }),
      PAGE,
      SOURCE,
    );
    expect(result).toMatchObject({ status: 'unverified', reason: 'unknown_time_zone' });
    expect(result).not.toHaveProperty('dates');
  });

  it('refuses a quoted zone that is not an IANA zone', () => {
    const result = normalizeExtractedRegistration(
      reading({ timeZone: 'Not/AZone', timeZoneEvidence: 'Eastern Time' }),
      PAGE,
      SOURCE,
    );
    expect(result).toMatchObject({ status: 'unverified', reason: 'unknown_time_zone' });
  });

  it('accepts the quoted real zone (positive control)', () => {
    const result = normalizeExtractedRegistration(reading(ZONE), PAGE, SOURCE);
    expect(result).toMatchObject({ status: 'verified', timeZone: 'America/New_York' });
  });
});

describe('a date the page prints without a time', () => {
  const page = (when: string) =>
    `Registration opens November 2, 2026${when}. Pool hours are Eastern Time.`;
  const reading = (quote: string, time: string | null) =>
    extracted({
      evidence: `Registration opens ${quote}`,
      yearEvidence: 'November 2, 2026',
      generalOpen: { quote, date: '2026-11-02', time },
    });

  it('anchors at the start of that local day and still says the time is unknown', () => {
    const result = normalizeExtractedRegistration(
      reading('November 2, 2026', null),
      page(''),
      SOURCE,
    );

    if (result.status !== 'verified') throw new Error(`expected verified, got ${result.status}`);
    const [date] = result.dates;
    if (!date) throw new Error('expected one date');
    expect(date.time).toBeNull();
    const anchor = registrationAnchor(result, date);
    // 00:00 EST: DST ended on 2026-11-01, so New York is UTC-5 here.
    expect(anchor.toISOString()).toBe('2026-11-02T05:00:00.000Z');
    expect(
      new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).format(anchor),
    ).toBe('00:00');
  });

  it('anchors at the printed time when there is one (control)', () => {
    const result = normalizeExtractedRegistration(
      reading('November 2, 2026 at 9 a.m.', '09:00'),
      page(' at 9 a.m.'),
      SOURCE,
    );
    expect(anchors(result)).toEqual({ general_open: '2026-11-02T14:00:00.000Z' });
  });
});

describe('a wall clock the zone skips', () => {
  const reading = (time: string, printed: string) => ({
    page: `Spring 2027. Public registration opens March 14, 2027 at ${printed}. Pool hours are Eastern Time.`,
    extracted: extracted({
      evidence: `Public registration opens March 14, 2027 at ${printed}.`,
      yearEvidence: 'March 14, 2027',
      generalOpen: { quote: `March 14, 2027 at ${printed}`, date: '2027-03-14', time },
    }),
  });

  it('is an invalid date, not an instant an hour away (02:30 on the DST-start morning)', () => {
    const { page, extracted: e } = reading('02:30', '2:30 a.m.');
    expect(normalizeExtractedRegistration(e, page, SOURCE)).toMatchObject({
      status: 'unverified',
      reason: 'invalid_date',
    });
  });

  it('verifies an hour later, once the clock exists (control)', () => {
    const { page, extracted: e } = reading('03:30', '3:30 a.m.');
    const result = normalizeExtractedRegistration(e, page, SOURCE);
    expect(anchors(result)).toEqual({ general_open: '2027-03-14T07:30:00.000Z' });
  });
});
