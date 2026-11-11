import { afterEach, describe, expect, it, vi } from 'vitest';
import { TEEN_NAME_SHARED_MATCHER_ENABLED_ENV } from '~/lib/privacy/teen-name';
import { namesTeenChild } from './teen-named';

const TEEN = { id: 'c-teen', name: 'Leo', ageInMonths: 160 };
const CHILD = { id: 'c-child', name: 'Leo', ageInMonths: 155 };

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('namesTeenChild', () => {
  it.each([
    ['plain', "Leo's swim class is cancelled"],
    ['upper case', 'REMINDER: LEO has practice'],
    ['accented', 'Léo a un rendez-vous'],
    ['fullwidth', 'Ｌｅｏ has an appointment'],
    ['zero-width split', 'Le​o has an appointment'],
    ['punctuated', 'Appointment for: leo, Thursday'],
    ['second text only', ''],
  ])('names a 13+ child: %s', (_label, text) => {
    const texts = text === '' ? ['Weekly update', 'Leo is on the list'] : [text];
    expect(namesTeenChild(texts, [TEEN])).toBe(true);
  });

  it.each([
    ['a longer name', 'Leonard has an appointment'],
    ['inside a word', 'Cleo has an appointment'],
    ['no name', 'An appointment was moved'],
  ])('does not match %s', (_label, text) => {
    expect(namesTeenChild([text], [TEEN])).toBe(false);
  });

  it('uses the given name, not a surname a younger sibling shares', () => {
    const teen = { id: 'c-1', name: 'Sam Rivers', ageInMonths: 170 };
    expect(namesTeenChild(['Sam has a dentist visit'], [teen])).toBe(true);
    expect(namesTeenChild(['Robin Rivers is registered'], [teen])).toBe(false);
  });

  /**
   * Lit, every name part of two or more letters is a hit. A younger sibling's
   * shared surname is then a hit too — more withholding, which is the safe
   * direction (rule #1).
   */
  it('lit, a surname a younger sibling shares is a hit (fail closed)', () => {
    vi.stubEnv(TEEN_NAME_SHARED_MATCHER_ENABLED_ENV, 'true');
    const teen = { name: 'Sam Rivers', ageInMonths: 170 };
    expect(namesTeenChild(['Robin Rivers is registered'], [teen])).toBe(true);
    expect(namesTeenChild(['Sofia has debate'], [{ name: 'Ana Sofia', ageInMonths: 170 }])).toBe(
      true,
    );
  });

  it('is the age gate: the same name under 13 is not a teen', () => {
    expect(namesTeenChild(["Leo's swim class is cancelled"], [CHILD])).toBe(false);
    expect(namesTeenChild(["Leo's swim class is cancelled"], [CHILD, TEEN])).toBe(true);
  });
});
