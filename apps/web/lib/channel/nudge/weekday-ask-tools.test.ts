import { describe, expect, it } from 'vitest';
import { readWeekdayAsk, weekdayAskContext } from './weekday-ask-tools';

const NAMED = { prompt: 'after_school_named', childId: 'child-1', name: 'Nell' } as const;
const BREAK = {
  prompt: 'verified_break',
  eventKey: 'winter-break-2026-12-21',
  label: 'winter break',
} as const;
const FALLBACK = { prompt: 'weekend_fallback' } as const;

describe('readWeekdayAsk', () => {
  it('keeps one question that names the child it was asked about', () => {
    expect(
      readWeekdayAsk({ message: 'Want me to look for one after-school option for Nell?' }, NAMED),
    ).toEqual({ message: 'Want me to look for one after-school option for Nell?' });
  });

  it('refuses a named ask that drops the name', () => {
    expect(readWeekdayAsk({ message: 'Want me to find an after-school option?' }, NAMED)).toEqual({
      skipped: 'missing_subject',
    });
  });

  it('refuses a break ask that does not say which break', () => {
    expect(readWeekdayAsk({ message: 'A day off is coming. Want me to look?' }, BREAK)).toEqual({
      skipped: 'missing_subject',
    });
    expect(
      readWeekdayAsk(
        { message: 'Winter break is coming up. Want me to find something nearby?' },
        BREAK,
      ),
    ).toEqual({ message: 'Winter break is coming up. Want me to find something nearby?' });
  });

  it('refuses a text that asks nothing, or asks twice', () => {
    expect(readWeekdayAsk({ message: 'I can look for weekday options too.' }, FALLBACK)).toEqual({
      skipped: 'not_one_question',
    });
    expect(readWeekdayAsk({ message: 'Weekdays too? Or just weekends?' }, FALLBACK)).toEqual({
      skipped: 'not_one_question',
    });
  });

  it('refuses a link or a clock time nobody gave it', () => {
    expect(
      readWeekdayAsk({ message: 'Want weekday ideas too? https://example.test/x' }, FALLBACK),
    ).toEqual({ skipped: 'invented' });
    expect(readWeekdayAsk({ message: 'Want something weekdays at 3:30?' }, FALLBACK)).toEqual({
      skipped: 'invented',
    });
  });

  it('refuses punctuation that doubles the cost of the text', () => {
    expect(
      readWeekdayAsk({ message: 'Those were weekends — want weekdays too?' }, FALLBACK),
    ).toEqual({ skipped: 'not_gsm7' });
  });

  it('refuses a text longer than a nudge may be', () => {
    const long = `${'Those were weekend options for the family. '.repeat(8)}Want weekdays too?`;
    expect(readWeekdayAsk({ message: long }, FALLBACK)).toEqual({ skipped: 'too_long' });
  });

  it('refuses anything that is not the tool shape', () => {
    expect(readWeekdayAsk({ message: '' }, FALLBACK)).toEqual({ skipped: 'unparsed' });
    expect(readWeekdayAsk({ message: 'Want weekdays?', extra: 1 }, FALLBACK)).toEqual({
      skipped: 'unparsed',
    });
    expect(readWeekdayAsk(null, FALLBACK)).toEqual({ skipped: 'unparsed' });
  });
});

describe('weekdayAskContext', () => {
  it('carries the prompt and only the subject that prompt names', () => {
    expect(JSON.parse(weekdayAskContext(NAMED))).toEqual({
      prompt: 'after_school_named',
      name: 'Nell',
    });
    expect(JSON.parse(weekdayAskContext(BREAK))).toEqual({
      prompt: 'verified_break',
      label: 'winter break',
    });
    expect(JSON.parse(weekdayAskContext(FALLBACK))).toEqual({ prompt: 'weekend_fallback' });
  });
});
