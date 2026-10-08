import { describe, expect, it } from 'vitest';
import { formatClaimPhone } from './claim-phone-format';

describe('formatClaimPhone', () => {
  it('groups a typed number as (555) 555-1234', () => {
    expect(formatClaimPhone('5555551234')).toBe('(555) 555-1234');
    expect(formatClaimPhone('555')).toBe('(555');
    expect(formatClaimPhone('555555')).toBe('(555) 555');
  });

  it('drops a leading country code once eleven digits are present', () => {
    expect(formatClaimPhone('+1 (555) 555-1234')).toBe('(555) 555-1234');
  });
});
