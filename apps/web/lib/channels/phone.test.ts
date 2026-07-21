import { describe, expect, it } from 'vitest';
import { maskPhoneE164, normalizePhoneE164 } from './phone';

describe('normalizePhoneE164 (NANP / CA+US only, v1)', () => {
  it('accepts a clean E.164 number', () => {
    expect(normalizePhoneE164('+15195551234')).toBe('+15195551234');
  });

  it('normalizes common human formats to E.164', () => {
    expect(normalizePhoneE164('(519) 555-1234')).toBe('+15195551234');
    expect(normalizePhoneE164('519-555-1234')).toBe('+15195551234');
    expect(normalizePhoneE164('519.555.1234')).toBe('+15195551234');
    expect(normalizePhoneE164('1 519 555 1234')).toBe('+15195551234');
    expect(normalizePhoneE164('+1 (519) 555-1234')).toBe('+15195551234');
  });

  it('rejects numbers with the wrong digit count', () => {
    expect(normalizePhoneE164('519555123')).toBeNull(); // 9 digits
    expect(normalizePhoneE164('+1519555123456')).toBeNull(); // too long
    expect(normalizePhoneE164('')).toBeNull();
  });

  it('rejects a non-NANP area or exchange code (must start 2-9)', () => {
    expect(normalizePhoneE164('+11195551234')).toBeNull(); // area code starts with 1
    expect(normalizePhoneE164('+15190551234')).toBeNull(); // exchange starts with 0
    expect(normalizePhoneE164('+05195551234')).toBeNull(); // not +1
  });

  it('rejects a non-+1 country code', () => {
    expect(normalizePhoneE164('+445195551234')).toBeNull(); // UK
    expect(normalizePhoneE164('+525195551234')).toBeNull(); // MX
  });

  it('rejects junk input', () => {
    expect(normalizePhoneE164('not a phone')).toBeNull();
    expect(normalizePhoneE164('+1abcdefghij')).toBeNull();
  });

  it('rejects an over-long input in O(1) (no unbounded scan of an authed payload)', () => {
    expect(normalizePhoneE164('1'.repeat(5000))).toBeNull();
    expect(normalizePhoneE164(`+1519555${'1'.repeat(5000)}`)).toBeNull();
  });
});

describe('maskPhoneE164', () => {
  it('reveals only the last four digits', () => {
    expect(maskPhoneE164('+15195551234')).toBe('••• ••• 1234');
  });
});
