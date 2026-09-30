import { describe, expect, it } from 'vitest';
import { firstTouchLadderEnabled } from './first-touch-flag';

describe('site FIRST_TOUCH_LADDER_ENABLED', () => {
  it('matches the web predicate: exact on after trim', () => {
    expect(firstTouchLadderEnabled({ FIRST_TOUCH_LADDER_ENABLED: 'on' })).toBe(true);
    expect(firstTouchLadderEnabled({ FIRST_TOUCH_LADDER_ENABLED: ' on ' })).toBe(true);
    expect(firstTouchLadderEnabled({})).toBe(false);
    expect(firstTouchLadderEnabled({ FIRST_TOUCH_LADDER_ENABLED: 'true' })).toBe(false);
    expect(firstTouchLadderEnabled({ FIRST_TOUCH_LADDER_ENABLED: '1' })).toBe(false);
    expect(firstTouchLadderEnabled({ FIRST_TOUCH_LADDER_ENABLED: 'ON' })).toBe(false);
  });
});
