import { describe, expect, it } from 'vitest';
import { type StoredParentLanguage, parentLanguage, stepParentLanguage } from './parent-language';

const UNSET: StoredParentLanguage = {
  proactiveLanguage: null,
  languageStreakTag: null,
  languageStreakCount: 0,
};

/** Feed a run of readings through the step, the way the router does one text at a time. */
function afterTexts(
  start: StoredParentLanguage,
  familyPrimary: string,
  readings: { seen: string | null; requested?: string | null }[],
) {
  let stored = start;
  const kinds: string[] = [];
  for (const reading of readings) {
    const step = stepParentLanguage(stored, familyPrimary, {
      seen: reading.seen,
      requested: reading.requested ?? null,
    });
    kinds.push(step.kind);
    stored = step.next;
  }
  return { stored, kinds, language: parentLanguage(stored.proactiveLanguage, familyPrimary) };
}

describe('parentLanguage', () => {
  it("is the parent's own stored language, else the family's, else English", () => {
    expect(parentLanguage('zh', 'en')).toBe('zh');
    expect(parentLanguage(null, 'fr')).toBe('fr');
    expect(parentLanguage(null, 'not a tag')).toBe('en');
  });
});

describe('stepParentLanguage', () => {
  it('one Chinese text among English ones does not change the language', () => {
    const run = afterTexts(UNSET, 'en', [
      { seen: 'en' },
      { seen: 'zh' },
      { seen: 'en' },
      { seen: 'en-US' },
    ]);
    expect(run.kinds).toEqual(['kept', 'counting', 'kept', 'kept']);
    expect(run.language).toBe('en');
    expect(run.stored).toEqual(UNSET);
  });

  it('three Chinese texts in a row make Chinese the language', () => {
    const run = afterTexts(UNSET, 'en', [{ seen: 'zh' }, { seen: 'zh-Hans' }, { seen: 'zh' }]);
    expect(run.kinds).toEqual(['counting', 'counting', 'switched']);
    expect(run.language).toBe('zh');
    expect(run.stored).toEqual({
      proactiveLanguage: 'zh',
      languageStreakTag: null,
      languageStreakCount: 0,
    });
  });

  it('two in a row, broken by the usual language, start again from zero', () => {
    const run = afterTexts(UNSET, 'en', [
      { seen: 'zh' },
      { seen: 'zh' },
      { seen: 'en' },
      { seen: 'zh' },
      { seen: 'zh' },
    ]);
    expect(run.kinds).toEqual(['counting', 'counting', 'kept', 'counting', 'counting']);
    expect(run.language).toBe('en');
  });

  it('a run that changes language part way counts the new language from one', () => {
    const run = afterTexts(UNSET, 'en', [{ seen: 'zh' }, { seen: 'ar' }, { seen: 'ar' }]);
    expect(run.kinds).toEqual(['counting', 'counting', 'counting']);
    expect(run.stored.languageStreakTag).toBe('ar');
    expect(run.stored.languageStreakCount).toBe(2);
    expect(run.language).toBe('en');
  });

  it('an explicit ask changes the language on that one text, whatever it was written in', () => {
    const run = afterTexts(UNSET, 'en', [{ seen: 'en', requested: 'fr' }]);
    expect(run.kinds).toEqual(['switched']);
    expect(run.language).toBe('fr');
    const step = stepParentLanguage(UNSET, 'en', { seen: 'en', requested: 'fr' });
    expect(step).toMatchObject({ kind: 'switched', from: 'en', to: 'fr', why: 'asked' });
  });

  it('measures against the family language when the parent has set nothing', () => {
    const run = afterTexts(UNSET, 'fr', [{ seen: 'fr-CA' }, { seen: 'en' }]);
    expect(run.kinds).toEqual(['kept', 'counting']);
    expect(run.language).toBe('fr');
  });

  it('a stored language is measured against, not the family one', () => {
    const zh: StoredParentLanguage = { ...UNSET, proactiveLanguage: 'zh' };
    const run = afterTexts(zh, 'en', [{ seen: 'en' }, { seen: 'zh' }]);
    expect(run.kinds).toEqual(['counting', 'kept']);
    expect(run.language).toBe('zh');
    expect(run.stored).toEqual(zh);
  });

  it('a text the screen read no language off leaves everything as it was', () => {
    const counting: StoredParentLanguage = {
      proactiveLanguage: null,
      languageStreakTag: 'zh',
      languageStreakCount: 2,
    };
    const step = stepParentLanguage(counting, 'en', { seen: null, requested: null });
    expect(step.kind).toBe('unread');
    expect(step.next).toEqual(counting);
    expect(stepParentLanguage(counting, 'en', { seen: 'not a tag', requested: null }).kind).toBe(
      'unread',
    );
  });
});
