import { describe, expect, it } from 'vitest';
import { floridaOrOklahoma, quietStartForPhone } from './quiet';

describe('Florida and Oklahoma quiet start', () => {
  it('starts at 20:00 for a Florida or an Oklahoma number', () => {
    expect(quietStartForPhone('+14075550100')).toBe('20:00');
    expect(quietStartForPhone('14055550100')).toBe('20:00');
    expect(floridaOrOklahoma('+19185550100')).toBe(true);
  });

  it('stays at 21:00 for any other number and for a number it cannot read', () => {
    expect(quietStartForPhone('+12065550100')).toBe('21:00');
    expect(quietStartForPhone(null)).toBe('21:00');
    expect(quietStartForPhone('555')).toBe('21:00');
  });
});
