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

  it('matches whole words, never a fragment of a longer word', () => {
    expect(groupLineLeaksPrivate('Available Saturday at 10.', ['Ava'])).toBe(false);
    expect(groupLineLeaksPrivate('The park plan is on.', ['Ark'])).toBe(false);
    expect(groupLineLeaksPrivate('Ava is coming.', ['Ava'])).toBe(true);
    expect(groupLineLeaksPrivate("Ava's coming.", ['Ava'])).toBe(true);
  });

  it('a name in a script written without spaces is still caught inside a sentence', () => {
    expect(groupLineLeaksPrivate('王小明今天去公园', ['王小明'])).toBe(true);
    expect(groupLineLeaksPrivate('今天去公园', ['王小明'])).toBe(false);
  });
});
