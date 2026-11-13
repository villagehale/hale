import { describe, expect, it } from 'vitest';
import { NEXT_DAY_CHECKBACK_ENABLED_ENV, nextDayCheckbackEnabled } from './flag';

describe('nextDayCheckbackEnabled', () => {
  it('is on when unset, and for any value but false', () => {
    expect(nextDayCheckbackEnabled({})).toBe(true);
    expect(nextDayCheckbackEnabled({ [NEXT_DAY_CHECKBACK_ENABLED_ENV]: 'true' })).toBe(true);
    expect(nextDayCheckbackEnabled({ [NEXT_DAY_CHECKBACK_ENABLED_ENV]: 'true\n' })).toBe(true);
  });

  it('is off for false, trimmed', () => {
    expect(nextDayCheckbackEnabled({ [NEXT_DAY_CHECKBACK_ENABLED_ENV]: 'false' })).toBe(false);
    expect(nextDayCheckbackEnabled({ [NEXT_DAY_CHECKBACK_ENABLED_ENV]: 'false\n' })).toBe(false);
  });
});
