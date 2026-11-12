import { describe, expect, it } from 'vitest';
import { groupLineLeaksPrivate } from './privacy';

describe('groupLineLeaksPrivate', () => {
  it('refuses a line that repeats a deny-list string, in any case', () => {
    const deny = ['peanut allergy', 'Dentist checkup'];
    expect(groupLineLeaksPrivate('About that Peanut Allergy.', deny)).toBe(true);
    expect(groupLineLeaksPrivate('The dentist checkup clashes.', deny)).toBe(true);
  });

  it('positive control: a line with none of them goes through', () => {
    expect(groupLineLeaksPrivate('I will text you.', ['peanut allergy'])).toBe(false);
  });
});
