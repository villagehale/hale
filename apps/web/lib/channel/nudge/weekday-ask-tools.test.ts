import { describe, expect, it } from 'vitest';
import { TEXT_CHARS } from '../proactive/tools';
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

  it('keeps the wording the model chose, whether or not it names the subject or asks once', () => {
    for (const [message, ask] of [
      ['Want me to find an after-school thing?', NAMED],
      ['A day off is coming. Want me to look?', BREAK],
      ['I can look at weekdays too.', FALLBACK],
      ['Weekdays too? Or just weekends?', FALLBACK],
      ['我可以找一个课后活动，要我找吗？', { ...NAMED, name: '乐乐' }],
      ['要找周末的吗？还是工作日？', FALLBACK],
    ] as const) {
      expect(readWeekdayAsk({ message }, ask)).toEqual({ message });
    }
  });

  it("keeps a long text that fits one text: the length is the model's to choose", () => {
    const long = `${'Those were weekend options for the family. '.repeat(8)}Want weekdays too?`;
    expect(readWeekdayAsk({ message: long }, FALLBACK)).toEqual({ message: long });
    const longChinese = `${'那些都是周末的活动。'.repeat(12)}要我也看看工作日吗？`;
    expect(readWeekdayAsk({ message: longChinese }, FALLBACK)).toEqual({ message: longChinese });
  });

  it('refuses a runaway text longer than one text, by name', () => {
    const sentence = 'Those were weekend options for the family. ';
    const atBound = `${sentence.repeat(Math.floor(TEXT_CHARS / sentence.length)).trim()}`;
    expect(atBound.length).toBeLessThanOrEqual(TEXT_CHARS);
    expect(readWeekdayAsk({ message: atBound }, FALLBACK)).toEqual({ message: atBound });
    const over = `${sentence.repeat(Math.ceil(TEXT_CHARS / sentence.length) + 1)}Want weekdays too?`;
    expect(over.trim().length).toBeGreaterThan(TEXT_CHARS);
    expect(readWeekdayAsk({ message: over }, FALLBACK)).toEqual({ skipped: 'over_length' });
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

  it('keeps a Chinese text that names the child as given', () => {
    const named = '乐乐放学后想找点事做吗？我帮你看看～';
    expect(readWeekdayAsk({ message: named }, { ...NAMED, name: '乐乐' })).toEqual({
      message: named,
    });
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
