import { describe, expect, it } from 'vitest';
import { DEFAULT_CHILD_GENDER, isChildGender, parseChildGender } from './child-gender.js';

describe('isChildGender', () => {
  it('accepts each known value', () => {
    for (const value of ['boy', 'girl', 'nonbinary', 'unspecified']) {
      expect(isChildGender(value)).toBe(true);
    }
  });

  it('rejects anything else', () => {
    expect(isChildGender('male')).toBe(false);
    expect(isChildGender('')).toBe(false);
    expect(isChildGender('Boy')).toBe(false);
  });
});

describe('parseChildGender', () => {
  it('passes through a known value unchanged', () => {
    expect(parseChildGender('girl')).toBe('girl');
    expect(parseChildGender('nonbinary')).toBe('nonbinary');
  });

  it('falls back to unspecified for an unknown, empty, or missing value', () => {
    expect(parseChildGender('male')).toBe('unspecified');
    expect(parseChildGender('')).toBe('unspecified');
    expect(parseChildGender(undefined)).toBe('unspecified');
    expect(parseChildGender(null)).toBe('unspecified');
  });

  it('uses the shared default constant for the fallback', () => {
    expect(parseChildGender('garbage')).toBe(DEFAULT_CHILD_GENDER);
    expect(DEFAULT_CHILD_GENDER).toBe('unspecified');
  });
});
