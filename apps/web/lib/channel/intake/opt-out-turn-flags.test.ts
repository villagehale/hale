import { afterEach, describe, expect, it } from 'vitest';
import {
  OPT_OUT_HOLD_WRITE_STOPS_TURN_ENV,
  OPT_OUT_UNREAD_HOLD_TURN_ENV,
  optOutHoldWriteStopsTurnEnabled,
  optOutUnreadHoldTurnEnabled,
} from './opt-out-turn-flags';

afterEach(() => {
  delete process.env[OPT_OUT_UNREAD_HOLD_TURN_ENV];
  delete process.env[OPT_OUT_HOLD_WRITE_STOPS_TURN_ENV];
});

describe('VIL-707 opt-out turn flags', () => {
  it('is on only for the exact string true', () => {
    expect(optOutUnreadHoldTurnEnabled({})).toBe(false);
    expect(optOutUnreadHoldTurnEnabled({ [OPT_OUT_UNREAD_HOLD_TURN_ENV]: 'true' })).toBe(true);
    expect(optOutUnreadHoldTurnEnabled({ [OPT_OUT_UNREAD_HOLD_TURN_ENV]: 'true\n' })).toBe(false);
    expect(optOutUnreadHoldTurnEnabled({ [OPT_OUT_UNREAD_HOLD_TURN_ENV]: 'TRUE' })).toBe(false);
    expect(optOutHoldWriteStopsTurnEnabled({})).toBe(false);
    expect(optOutHoldWriteStopsTurnEnabled({ [OPT_OUT_HOLD_WRITE_STOPS_TURN_ENV]: 'true' })).toBe(
      true,
    );
    expect(optOutHoldWriteStopsTurnEnabled({ [OPT_OUT_HOLD_WRITE_STOPS_TURN_ENV]: 'true\n' })).toBe(
      false,
    );
  });
});
