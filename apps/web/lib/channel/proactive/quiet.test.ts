import { describe, expect, it } from 'vitest';
import { floridaOrOklahoma, quietStartForPhone } from './quiet';

describe('Florida and Oklahoma quiet start', () => {
  it('starts at 20:00 for an Orlando or Oklahoma City number', () => {
    expect(quietStartForPhone('+14075550100')).toBe('20:00');
    expect(floridaOrOklahoma('+14055550100')).toBe(true);
  });

  it('stays at 21:00 for a Toronto number and for a number we cannot read', () => {
    expect(quietStartForPhone('+14165550100')).toBe('21:00');
    expect(quietStartForPhone(null)).toBe('21:00');
    expect(quietStartForPhone('555')).toBe('21:00');
  });
});
