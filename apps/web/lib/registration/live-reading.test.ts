import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readCourseModel } from '~/lib/channel/spots/availability';
import {
  type RegistrationReadSource,
  normalizeExtractedRegistration,
  readCourseRegistration,
} from './live-reading';
import type { ExtractedWindow } from './verify-window';

const COURSE_ID = '961140fe-0866-460f-9973-7c42cbe0a928';
const RAW = readFileSync(
  join(__dirname, '../channel/spots/fixtures/open-window-open-markham.html'),
  'utf8',
);
const SOURCE: RegistrationReadSource = {
  sourceUrl: 'https://www.markham.ca/registration',
  checkedAt: new Date('2026-08-01T12:00:00Z'),
  timeZone: 'America/Toronto',
};
// Tests below exercise normalization, not model quality; no LLM response is mocked.
const PAGE = 'Fall 2026. Preview August 3. Register August 11 at 06:30.';
const EXTRACTED: ExtractedWindow = {
  found: true,
  reason: null,
  cycleOnPage: 'Fall 2026',
  yearEvidence: 'Fall 2026',
  preview: { date: '2026-08-03', time: null },
  residentOpen: null,
  generalOpen: { date: '2026-08-11', time: '06:30' },
  evidence: PAGE,
  confidence: 0.95,
};

function extraction(extracted: ExtractedWindow = EXTRACTED, source = SOURCE) {
  return normalizeExtractedRegistration({ ok: true, extracted, pageText: PAGE }, source);
}

function course(raw = RAW, source = SOURCE, courseId = COURSE_ID) {
  return readCourseRegistration({ ok: true, raw }, { ...source, courseId });
}

function variant(overrides: Record<string, unknown>): string {
  const read = readCourseModel(RAW, COURSE_ID);
  if (!read.ok) throw new Error('expected saved course model');
  return RAW.replace(read.blob, JSON.stringify({ ...read.model, ...overrides }));
}

describe('shared live registration reading', () => {
  it('accepts a unique weekday year but rejects a weekday mismatch and month/day-only guess', () => {
    const source = { ...SOURCE, checkedAt: new Date('2026-10-10T12:00:00Z') };
    const page = 'Registration opens Tuesday, October 20 at 09:00.';
    const extracted = {
      ...EXTRACTED,
      preview: null,
      generalOpen: { date: '2026-10-20', time: '09:00' },
      yearEvidence: 'Tuesday, October 20',
      evidence: page,
    };
    expect(
      normalizeExtractedRegistration({ ok: true, extracted, pageText: page }, source),
    ).toMatchObject({ status: 'verified' });
    expect(
      normalizeExtractedRegistration(
        {
          ok: true,
          extracted: { ...extracted, generalOpen: { date: '2027-10-20', time: '09:00' } },
          pageText: page,
        },
        source,
      ),
    ).toMatchObject({ reason: 'uncorroborated' });
    expect(
      normalizeExtractedRegistration(
        { ok: true, extracted: { ...extracted, yearEvidence: 'October 20' }, pageText: page },
        source,
      ),
    ).toMatchObject({ reason: 'uncorroborated' });
  });
  it('normalizes a saved course without a stored window or family anchor', () => {
    const result = course();
    expect(result).toMatchObject({
      status: 'verified',
      reader: 'perfectmind',
      ...SOURCE,
      dates: expect.arrayContaining([
        {
          kind: 'resident_open',
          date: '2026-08-11',
          time: '06:30',
          evidence: [expect.any(String)],
        },
        { kind: 'general_open', date: '2026-08-12', time: '06:30', evidence: [expect.any(String)] },
      ]),
    });
    if (result.status !== 'verified') throw new Error('expected verified dates');
    expect(result.dates.every((date) => date.evidence.every((quote) => RAW.includes(quote)))).toBe(
      true,
    );
    expect(result.dates.some((date) => date.kind === 'member_open')).toBe(true);
    // Class start time is not a registration opening.
    expect(result.dates).toHaveLength(3);
  });

  it('uses the same result shape for AI extraction and preserves date-only precision', () => {
    const result = extraction();
    expect(result).toEqual({
      ...SOURCE,
      reader: 'ai',
      status: 'verified',
      dates: [
        { kind: 'preview', date: '2026-08-03', time: null, evidence: [PAGE, 'Fall 2026'] },
        { kind: 'general_open', date: '2026-08-11', time: '06:30', evidence: [PAGE, 'Fall 2026'] },
      ],
    });
  });

  it('does not infer a missing public date from a resident date', () => {
    const result = extraction({
      ...EXTRACTED,
      preview: null,
      residentOpen: EXTRACTED.generalOpen,
      generalOpen: null,
    });
    expect(result).toMatchObject({ status: 'verified', dates: [{ kind: 'resident_open' }] });
  });

  it('retains the year evidence that made an AI date trustworthy', () => {
    const result = extraction();
    if (result.status !== 'verified') throw new Error('expected verified dates');
    expect(result.dates[0]?.evidence).toEqual([PAGE, 'Fall 2026']);
  });

  it.each(['America/New_York', 'Europe/London'])(
    'preserves the explicit source zone %s',
    (timeZone) => {
      expect(extraction(EXTRACTED, { ...SOURCE, timeZone })).toMatchObject({
        status: 'verified',
        timeZone,
      });
    },
  );

  it.each([null, 'not/a-zone', ''])(
    'never defaults a missing/invalid source zone %s',
    (timeZone) => {
      expect(extraction(EXTRACTED, { ...SOURCE, timeZone })).toMatchObject({
        status: 'unverified',
        reason: 'unknown_time_zone',
      });
      expect(course(RAW, { ...SOURCE, timeZone })).toMatchObject({
        status: 'unverified',
        reason: 'unknown_time_zone',
      });
    },
  );

  it('rejects low-confidence and fabricated AI evidence without exposing dates', () => {
    for (const [extracted, reason] of [
      [{ ...EXTRACTED, confidence: 0.4 }, 'low_confidence'],
      [{ ...EXTRACTED, evidence: 'invented quote' }, 'uncorroborated'],
      [{ ...EXTRACTED, generalOpen: { date: '2027-08-11', time: '06:30' } }, 'uncorroborated'],
    ] as const) {
      const result = extraction(extracted);
      expect(result).toMatchObject({ status: 'unverified', reason });
      expect(result).not.toHaveProperty('dates');
    }
  });

  it('rejects a made-up date or time even when the copied quote and year are real', () => {
    for (const generalOpen of [
      { date: '2026-09-11', time: '06:30' },
      { date: '2026-08-11', time: '07:00' },
    ]) {
      expect(extraction({ ...EXTRACTED, generalOpen })).toMatchObject({
        status: 'unverified',
        reason: 'uncorroborated',
      });
    }
  });
  it('cannot borrow the clock of the next class or registration row', () => {
    for (const evidence of [
      'Registration opens October 20, 2026. Classes start November 2 at 4 p.m.',
      'Resident registration opens October 20, 2026. Public registration opens October 21 at 4 p.m.',
    ]) {
      expect(
        normalizeExtractedRegistration(
          {
            ok: true,
            pageText: evidence,
            extracted: {
              ...EXTRACTED,
              preview: null,
              residentOpen: null,
              generalOpen: { date: '2026-10-20', time: '16:00' },
              evidence,
              yearEvidence: '2026',
            },
          },
          SOURCE,
        ),
      ).toMatchObject({ status: 'unverified', reason: 'uncorroborated' });
    }
  });

  it.each([
    { date: '2026-02-30', time: '06:30' },
    { date: '2026-08-11', time: '24:00' },
    { date: '2026-08-11', time: '06:60' },
    { date: '2026-08-11', time: '6:30' },
  ])('rejects an invalid calendar date or clock %j', (generalOpen) => {
    expect(extraction({ ...EXTRACTED, generalOpen })).toMatchObject({
      status: 'unverified',
      reason: 'invalid_date',
    });
  });

  it('keeps no published dates distinct from a failed read', () => {
    expect(
      extraction({
        ...EXTRACTED,
        found: false,
        reason: 'announced_later',
        preview: null,
        generalOpen: null,
      }),
    ).toMatchObject({ status: 'unverified', reason: 'announced_later' });
    expect(extraction({ ...EXTRACTED, preview: null, generalOpen: null })).toMatchObject({
      status: 'unverified',
      reason: 'no_dates_for_cycle',
    });
    expect(normalizeExtractedRegistration({ ok: false, reason: 'extract_failed' }, SOURCE)).toEqual(
      { ...SOURCE, reader: 'ai', status: 'unreadable', reason: 'extract_failed' },
    );
    expect(
      readCourseRegistration(
        { ok: false, reason: 'fetch_failed' },
        { ...SOURCE, courseId: COURSE_ID },
      ),
    ).toEqual({ ...SOURCE, reader: 'perfectmind', status: 'unreadable', reason: 'fetch_failed' });
  });

  it('does not turn a challenge page or wrong course into a missing course', () => {
    expect(course('<html>challenge</html>')).toMatchObject({
      status: 'unreadable',
      reason: 'no_model',
    });
    expect(course(RAW, SOURCE, 'another-course')).toMatchObject({
      status: 'unreadable',
      reason: 'wrong_course',
    });
    expect(course('<title>BookMe4 Error Page</title>Course was not found')).toMatchObject({
      status: 'gone',
      evidence: ['<title>BookMe4 Error Page', 'was not found'],
    });
  });

  it('does not return class start as an opening when registration clocks are absent', () => {
    expect(
      course(
        variant({
          ResidentsRegistrationDateValue: null,
          MembersRegistrationDateValue: null,
          PublicRegistrationStartDateValue: null,
        }),
      ),
    ).toMatchObject({ status: 'unverified', reason: 'not_published' });
  });

  it('refuses invalid course clocks instead of returning a partial verified reading', () => {
    expect(
      course(variant({ PublicRegistrationStartDateValue: '2026-02-30T06:30:00' })),
    ).toMatchObject({ status: 'unverified', reason: 'invalid_date' });
  });
});
