import { describe, expect, it } from 'vitest';
import { namesTeenChild } from './teen-named';

const TEEN = { id: 'c-teen', name: 'Leo', ageInMonths: 160 };
const CHILD = { id: 'c-child', name: 'Leo', ageInMonths: 155 };

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

  it('is the age gate: the same name under 13 is not a teen', () => {
    expect(namesTeenChild(["Leo's swim class is cancelled"], [CHILD])).toBe(false);
    expect(namesTeenChild(["Leo's swim class is cancelled"], [CHILD, TEEN])).toBe(true);
  });
});
