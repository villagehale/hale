import { describe, expect, it } from 'vitest';
import { POLL_INTERVAL_MS, POLL_WINDOW_MS, nextPollStep } from './checkout-poll.js';

describe('nextPollStep', () => {
  it('polls every 4 seconds for up to a minute', () => {
    expect(POLL_INTERVAL_MS).toBe(4_000);
    expect(POLL_WINDOW_MS).toBe(60_000);
  });

  it('refreshes the page as soon as the payment has settled', () => {
    expect(nextPollStep({ settled: true, elapsedMs: 4_000 })).toBe('refresh');
  });

  it('keeps waiting while it has not', () => {
    expect(nextPollStep({ settled: false, elapsedMs: 4_000 })).toBe('wait');
    expect(nextPollStep({ settled: false, elapsedMs: 59_999 })).toBe('wait');
  });

  it('stops at a minute and swaps to the slow line', () => {
    expect(nextPollStep({ settled: false, elapsedMs: 60_000 })).toBe('expire');
  });

  it('still refreshes when the answer arrives at the minute', () => {
    expect(nextPollStep({ settled: true, elapsedMs: 60_000 })).toBe('refresh');
  });
});
