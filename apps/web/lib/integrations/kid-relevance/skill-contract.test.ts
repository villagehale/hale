import { describe, expect, it } from 'vitest';
import { repeatsAny, sharesAnyWord } from './skill-contract';

describe('the stored-reason word checks', () => {
  it('compare without accents, so a reason that drops or adds one still carries the word', () => {
    expect(sharesAnyWord('a checkup with Jose for a toddler', ['José Ortiz'])).toBe(true);
    expect(sharesAnyWord('a checkup with José for a toddler', ['Jose Ortiz'])).toBe(true);
    expect(repeatsAny('Chloe swim, a lesson', ['Chloé swim'])).toBe(true);
    expect(repeatsAny('Chloé swim, a lesson', ['Chloe swim'])).toBe(true);
  });
});
