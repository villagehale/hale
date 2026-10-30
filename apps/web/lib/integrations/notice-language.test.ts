import { describe, expect, it } from 'vitest';
import { noticeLanguage } from './notice-language';

describe('noticeLanguage', () => {
  it('is the language the parent texts in, whatever the profile says', () => {
    // A zh-CN profile whose parent texts Hale in English is written to in English.
    expect(
      noticeLanguage({ textedRecently: true, parentLocale: 'en', familyPrimary: 'zh-CN' }),
    ).toBe('en');
    expect(noticeLanguage({ textedRecently: true, parentLocale: 'fr', familyPrimary: 'en' })).toBe(
      'fr',
    );
  });

  it('uses the profile only as a hint when the parent has not texted', () => {
    expect(
      noticeLanguage({ textedRecently: false, parentLocale: 'en-CA', familyPrimary: 'zh-CN' }),
    ).toBe('zh-cn');
    expect(noticeLanguage({ textedRecently: false, parentLocale: 'fr', familyPrimary: null })).toBe(
      'fr',
    );
  });

  it('never takes free text for a tag', () => {
    expect(
      noticeLanguage({
        textedRecently: true,
        parentLocale: 'I speak English',
        familyPrimary: 'es',
      }),
    ).toBe('es');
  });
});
