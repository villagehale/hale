import { describe, expect, it } from 'vitest';
import { firstTouchLadderEnabled } from './first-touch-flag';

describe('FIRST_TOUCH_LADDER_ENABLED', () => {
  it('is on only for the exact word on, after trim', () => {
    expect(firstTouchLadderEnabled({ FIRST_TOUCH_LADDER_ENABLED: 'on' })).toBe(true);
    expect(firstTouchLadderEnabled({ FIRST_TOUCH_LADDER_ENABLED: 'on\n' })).toBe(true);
    expect(firstTouchLadderEnabled({ FIRST_TOUCH_LADDER_ENABLED: '  on  ' })).toBe(true);
  });

  it('stays off for unset, true, 1, and ON', () => {
    expect(firstTouchLadderEnabled({})).toBe(false);
    expect(firstTouchLadderEnabled({ FIRST_TOUCH_LADDER_ENABLED: '' })).toBe(false);
    expect(firstTouchLadderEnabled({ FIRST_TOUCH_LADDER_ENABLED: 'true' })).toBe(false);
    expect(firstTouchLadderEnabled({ FIRST_TOUCH_LADDER_ENABLED: 'ON' })).toBe(false);
    expect(firstTouchLadderEnabled({ FIRST_TOUCH_LADDER_ENABLED: '1' })).toBe(false);
    expect(firstTouchLadderEnabled({ FIRST_TOUCH_LADDER_ENABLED: 'off' })).toBe(false);
  });
});
