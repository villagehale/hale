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

  it('keeps a French text with the accents French needs', () => {
    const french = "Je peux chercher une activité après l'école pour Nell, ça te dirait ?";
    expect(readWeekdayAsk({ message: french }, NAMED)).toEqual({ message: french });
  });

  it('keeps a Chinese text that asks once and names the child as given', () => {
    const chinese = '我可以帮Nell找一个不错的课后活动，要我找一个吗？';
    expect(readWeekdayAsk({ message: chinese }, NAMED)).toEqual({ message: chinese });
    const named = '我可以帮乐乐找一个不错的课后活动，要我找吗？';
    expect(readWeekdayAsk({ message: named }, { ...NAMED, name: '乐乐' })).toEqual({
      message: named,
    });
    expect(
      readWeekdayAsk({ message: '我可以找一个课后活动，要我找吗？' }, { ...NAMED, name: '乐乐' }),
    ).toEqual({ skipped: 'missing_subject' });
    expect(readWeekdayAsk({ message: '要找周末的吗？还是工作日？' }, FALLBACK)).toEqual({
      skipped: 'not_one_question',
    });
  });

  it('counts a dash that changes the encoding against the budget, not as a refusal', () => {
    const body =
      'Those were all weekend options, and a weekday morning or two might suit the family better this time';
    expect(readWeekdayAsk({ message: `${body} - want me to look?` }, FALLBACK)).toEqual({
      message: `${body} - want me to look?`,
    });
    expect(readWeekdayAsk({ message: `${body} — want me to look?` }, FALLBACK)).toEqual({
      skipped: 'too_long',
    });
  });

  it('refuses a text longer than a nudge may be', () => {
    const long = `${'Those were weekend options for the family. '.repeat(8)}Want weekdays too?`;
    expect(readWeekdayAsk({ message: long }, FALLBACK)).toEqual({ skipped: 'too_long' });
    const longChinese = `${'那些都是周末的活动。'.repeat(12)}要我也看看工作日吗？`;
    expect(readWeekdayAsk({ message: longChinese }, FALLBACK)).toEqual({ skipped: 'too_long' });
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
  it('carries the prompt, the family language and only the subject that prompt names', () => {
    expect(JSON.parse(weekdayAskContext(NAMED, 'en'))).toEqual({
      prompt: 'after_school_named',
      language: 'en',
      name: 'Nell',
    });
    expect(JSON.parse(weekdayAskContext(BREAK, 'fr'))).toEqual({
      prompt: 'verified_break',
      language: 'fr',
      label: 'winter break',
    });
    expect(JSON.parse(weekdayAskContext(FALLBACK, 'fr'))).toEqual({
      prompt: 'weekend_fallback',
      language: 'fr',
    });
  });
});
