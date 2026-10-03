import { describe, expect, it } from 'vitest';
import { firstTouchLadderEnabled, firstTouchLocationCardEnabled } from './first-touch-flag';

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

describe('FIRST_TOUCH_LOCATION_CARD_ENABLED', () => {
  it('is on only for the exact string true', () => {
    expect(firstTouchLocationCardEnabled({ FIRST_TOUCH_LOCATION_CARD_ENABLED: 'true' })).toBe(
      true,
    );
  });

  it('stays off when unset, or for on, 1, TRUE, and a trailing newline', () => {
    expect(firstTouchLocationCardEnabled({})).toBe(false);
    expect(firstTouchLocationCardEnabled({ FIRST_TOUCH_LOCATION_CARD_ENABLED: '' })).toBe(false);
    expect(firstTouchLocationCardEnabled({ FIRST_TOUCH_LOCATION_CARD_ENABLED: 'on' })).toBe(false);
    expect(firstTouchLocationCardEnabled({ FIRST_TOUCH_LOCATION_CARD_ENABLED: '1' })).toBe(false);
    expect(firstTouchLocationCardEnabled({ FIRST_TOUCH_LOCATION_CARD_ENABLED: 'TRUE' })).toBe(
      false,
    );
    expect(firstTouchLocationCardEnabled({ FIRST_TOUCH_LOCATION_CARD_ENABLED: 'true\n' })).toBe(
      false,
    );
    expect(firstTouchLocationCardEnabled({ FIRST_TOUCH_LOCATION_CARD_ENABLED: ' true ' })).toBe(
      false,
    );
  });
});
