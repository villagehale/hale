import { describe, expect, it } from 'vitest';
import { MID_ACTIVITY_ASK_ENABLED_ENV, midActivityAskEnabled } from './flag';

describe('midActivityAskEnabled', () => {
  it('is on only for the exact string true', () => {
    expect(midActivityAskEnabled({ [MID_ACTIVITY_ASK_ENABLED_ENV]: 'true' })).toBe(true);
  });

  it('stays off for every other value, including a trailing newline and unset', () => {
    expect(midActivityAskEnabled({})).toBe(false);
    expect(midActivityAskEnabled({ [MID_ACTIVITY_ASK_ENABLED_ENV]: '' })).toBe(false);
    expect(midActivityAskEnabled({ [MID_ACTIVITY_ASK_ENABLED_ENV]: 'true\n' })).toBe(false);
    expect(midActivityAskEnabled({ [MID_ACTIVITY_ASK_ENABLED_ENV]: 'TRUE' })).toBe(false);
    expect(midActivityAskEnabled({ [MID_ACTIVITY_ASK_ENABLED_ENV]: '1' })).toBe(false);
    expect(midActivityAskEnabled({ [MID_ACTIVITY_ASK_ENABLED_ENV]: 'on' })).toBe(false);
    expect(midActivityAskEnabled({ [MID_ACTIVITY_ASK_ENABLED_ENV]: 'false' })).toBe(false);
  });
});
