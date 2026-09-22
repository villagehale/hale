import { describe, expect, it } from 'vitest';
import { OPT_OUT_LINE } from '~/lib/channel/opt-out';
import { isPrintableGsm7Basic, smsSegments } from '~/lib/channel/sms-segments';
import {
  WEEKDAY_AFTER_SCHOOL_FOR_MAYA,
  WEEKDAY_AFTER_SCHOOL_NEARBY,
  WEEKDAY_PA_DAY_ASK,
  WEEKDAY_WEEKEND_FALLBACK,
  printableWeekdayName,
  renderWeekdayFinderAsk,
  weekdayVerifiedBreakAsk,
} from './weekday-care-copy';

/**
 * Design lock (Sloane, 2026-09-21, 21:22 ET). The three parent-facing strings are
 * byte-stable. A test that only compares a function to a constant it also owns
 * would not catch a paraphrase of both.
 */

const LOCKED = [
  WEEKDAY_AFTER_SCHOOL_FOR_MAYA,
  WEEKDAY_AFTER_SCHOOL_NEARBY,
  WEEKDAY_PA_DAY_ASK,
  WEEKDAY_WEEKEND_FALLBACK,
];

describe('locked weekday-finder asks', () => {
  it('school-age under 13 is this sentence for Maya', () => {
    expect(WEEKDAY_AFTER_SCHOOL_FOR_MAYA).toBe(
      'Want me to find one good after-school option for Maya too?',
    );
    expect(
      renderWeekdayFinderAsk({ prompt: 'after_school_named', childId: 'maya', name: 'Maya' }),
    ).toBe('Want me to find one good after-school option for Maya too?');
  });

  it('a teen household is this sentence and names nobody', () => {
    expect(WEEKDAY_AFTER_SCHOOL_NEARBY).toBe(
      'Want me to find one good after-school option nearby too?',
    );
    expect(renderWeekdayFinderAsk({ prompt: 'after_school_household' })).toBe(
      'Want me to find one good after-school option nearby too?',
    );
  });

  it('a verified PA day is this sentence', () => {
    expect(WEEKDAY_PA_DAY_ASK).toBe(
      "There's a PA day coming up. Want me to find something nearby?",
    );
    expect(
      renderWeekdayFinderAsk({
        prompt: 'verified_break',
        eventKey: 'pa-day-2026-10-09',
        label: 'PA day',
      }),
    ).toBe("There's a PA day coming up. Want me to find something nearby?");
  });

  it('a verified named break keeps the same shape and uses that name', () => {
    expect(weekdayVerifiedBreakAsk('March break')).toBe(
      "There's a March break coming up. Want me to find something nearby?",
    );
  });

  it('the fallback, when school context is unknown, is this sentence', () => {
    expect(WEEKDAY_WEEKEND_FALLBACK).toBe(
      'Those are weekend options. Want me to find something for weekdays too?',
    );
    expect(renderWeekdayFinderAsk({ prompt: 'weekend_fallback' })).toBe(
      'Those are weekend options. Want me to find something for weekdays too?',
    );
  });

  it('is GSM-7 and fits one segment with the opt-out line', () => {
    for (const ask of LOCKED) {
      expect(isPrintableGsm7Basic(ask)).toBe(true);
      expect(smsSegments(`${ask}\n\n${OPT_OUT_LINE}`)).toBe(1);
    }
    expect(isPrintableGsm7Basic(weekdayVerifiedBreakAsk('March break'))).toBe(true);
  });

  it('asks one question and makes no unsupported claim', () => {
    for (const ask of [
      WEEKDAY_AFTER_SCHOOL_FOR_MAYA,
      WEEKDAY_AFTER_SCHOOL_NEARBY,
      WEEKDAY_WEEKEND_FALLBACK,
    ]) {
      expect(ask.split('?')).toHaveLength(2);
      expect(ask.toLowerCase()).not.toContain('weekends are covered');
      expect(ask.toLowerCase()).not.toContain("how's school");
      expect(ask.toLowerCase()).not.toContain('sports, art, tutoring');
      expect(ask.toLowerCase()).not.toContain('pa day');
      expect(ask.toLowerCase()).not.toContain('march break');
      expect(ask.toLowerCase()).not.toContain('daycare');
    }
  });
});

describe('printableWeekdayName', () => {
  it('prints a GSM-7 given name', () => {
    expect(printableWeekdayName('Maya')).toBe('Maya');
  });

  it('refuses a name SMS cannot spell, and a missing name', () => {
    expect(printableWeekdayName('Zoë')).toBeNull();
    expect(printableWeekdayName(null)).toBeNull();
    expect(printableWeekdayName('  ')).toBeNull();
  });
});
