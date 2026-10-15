import { describe, expect, it } from 'vitest';
import {
  acceptReplyLanguage,
  certainLanguageHint,
  copyFor,
  copyLanguage,
  localeFor,
  replyLanguage,
} from './language';

const TABLE = { en: 'hello', fr: 'bonjour' };

describe('reply language is a stored tag', () => {
  it.each(['en', 'fr', 'zh', 'ar', 'es', 'pt', 'fr-ca', 'zh-hant'])('keeps %s', (tag) => {
    expect(acceptReplyLanguage(tag)).toBe(tag);
    expect(replyLanguage(tag)).toBe(tag);
    expect(certainLanguageHint(tag)).toBe(tag);
  });

  it('folds case and surrounding space', () => {
    expect(acceptReplyLanguage(' FR-CA ')).toBe('fr-ca');
  });

  it('does not classify a sentence or an empty body', () => {
    for (const body of [
      'Bonjour',
      "Bonjour, j'ai deux enfants",
      'Maya is 4 and Leo is 2, M5V 3A8',
      'STOP',
      'ARRET',
      'désactiver mon adresse de transfert',
      '你好',
      'مرحبا',
      '',
      '👍',
    ]) {
      expect(replyLanguage(body)).toBeNull();
      expect(certainLanguageHint(body)).toBeNull();
    }
  });

  it('drops a value that is not a tag', () => {
    expect(acceptReplyLanguage(null)).toBeNull();
    expect(acceptReplyLanguage(undefined)).toBeNull();
    expect(acceptReplyLanguage('english')).toBeNull();
    expect(acceptReplyLanguage('fr_CA')).toBeNull();
    expect(acceptReplyLanguage('e')).toBeNull();
  });
});

describe('fixed templates only for English and French', () => {
  it('maps the Canadian region tags onto the two templates', () => {
    expect(copyLanguage('en')).toBe('en');
    expect(copyLanguage('en-ca')).toBe('en');
    expect(copyLanguage('fr')).toBe('fr');
    expect(copyLanguage('fr-ca')).toBe('fr');
  });

  it('does not hand Chinese, Arabic, or a sentence the English line', () => {
    expect(copyLanguage('zh')).toBeNull();
    expect(copyLanguage('ar')).toBeNull();
    expect(copyLanguage('bonjour')).toBeNull();
    expect(copyFor(TABLE, 'zh')).toBeNull();
    expect(copyFor(TABLE, null)).toBeNull();
    expect(copyFor(TABLE, 'fr')).toBe('bonjour');
  });
});

describe('locale for a stored tag', () => {
  it('keeps the Canadian default for bare en and fr', () => {
    expect(localeFor('en')).toBe('en-CA');
    expect(localeFor('fr')).toBe('fr-CA');
    expect(localeFor(null)).toBe('en-CA');
  });

  it('passes other tags through', () => {
    expect(localeFor('zh')).toBe('zh');
    expect(localeFor('ar')).toBe('ar');
    expect(localeFor('fr-ca')).toBe('fr-ca');
  });
});
