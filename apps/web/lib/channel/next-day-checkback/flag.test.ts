import { describe, expect, it } from 'vitest';
import { NEXT_DAY_CHECKBACK_ENABLED_ENV, nextDayCheckbackEnabled } from './flag';

describe('nextDayCheckbackEnabled', () => {
  it('is on only for the exact string true', () => {
    expect(nextDayCheckbackEnabled({ [NEXT_DAY_CHECKBACK_ENABLED_ENV]: 'true' })).toBe(true);
  });

  it('stays off for every other value, including a trailing newline and unset', () => {
    expect(nextDayCheckbackEnabled({})).toBe(false);
    expect(nextDayCheckbackEnabled({ [NEXT_DAY_CHECKBACK_ENABLED_ENV]: '' })).toBe(false);
    expect(nextDayCheckbackEnabled({ [NEXT_DAY_CHECKBACK_ENABLED_ENV]: 'true\n' })).toBe(false);
    expect(nextDayCheckbackEnabled({ [NEXT_DAY_CHECKBACK_ENABLED_ENV]: 'TRUE' })).toBe(false);
    expect(nextDayCheckbackEnabled({ [NEXT_DAY_CHECKBACK_ENABLED_ENV]: '1' })).toBe(false);
    expect(nextDayCheckbackEnabled({ [NEXT_DAY_CHECKBACK_ENABLED_ENV]: 'on' })).toBe(false);
    expect(nextDayCheckbackEnabled({ [NEXT_DAY_CHECKBACK_ENABLED_ENV]: 'false' })).toBe(false);
  });
});
