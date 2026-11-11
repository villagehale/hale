import { describe, expect, it } from 'vitest';
import { emptyFamilySlice } from '../multi-family';
import { groupLineLeaksPrivate, privateDenyTokens } from './privacy';

describe('privateDenyTokens', () => {
  it('uses the private slice strings, not a word list', () => {
    const slice = {
      ...emptyFamilySlice('fam-1'),
      memory: ['peanut allergy'],
      calendar: ['Dr Chen 3pm'],
      email: [],
      signups: [],
      children: ['Noah'],
    };
    const deny = privateDenyTokens([slice]);
    expect(deny).toEqual(['peanut allergy', 'Dr Chen 3pm']);
    expect(groupLineLeaksPrivate('I will text you.', deny)).toBe(false);
    expect(groupLineLeaksPrivate('About that peanut allergy —', deny)).toBe(true);
  });
});
