import { describe, expect, it } from 'vitest';
import { CHANNEL_MESSAGE_RECEIVED_RETRY, TURN_DEADLINE_MS } from '~/lib/channel/config';
import {
  DRAIN_PICKUP_MS,
  ackWindowMinutes,
  lateWindowMinutes,
  retryCeilingMs,
  sayableMinutes,
} from './window';

/**
 * VIL-717 · the times an ack and a late note may state are computed from the queue's own
 * settings. These pin the arithmetic, so a change to the turn deadline or the retry policy
 * moves the stated window with it instead of leaving a promise Hale can no longer keep.
 */

describe('the ack window', () => {
  it('is the turn, the first retry, one pickup and the retried turn, rounded up', () => {
    const ms =
      TURN_DEADLINE_MS +
      CHANNEL_MESSAGE_RECEIVED_RETRY.retryDelay * 2 * 1000 +
      DRAIN_PICKUP_MS +
      TURN_DEADLINE_MS;
    expect(ackWindowMinutes()).toBe(Math.ceil(ms / 60_000));
    // With today's settings: 90s + 30s + 60s + 90s = 4.5 minutes, stated as five.
    expect(ackWindowMinutes()).toBe(5);
  });
});

describe('the retry ceiling', () => {
  it('adds every retry’s longest backoff to a turn and a pickup per attempt', () => {
    // 15·(2+4+…+256) = 7650s of backoff, and nine attempts of 90s + 60s.
    expect(retryCeilingMs()).toBe(7_650_000 + 9 * 150_000);
  });
});

describe('a time as a person says it', () => {
  it.each([
    [1, 5],
    [4 * 60_000 + 1, 5],
    [5 * 60_000, 5],
    [5 * 60_000 + 1, 10],
    [59 * 60_000, 60],
    [60 * 60_000 + 1, 120],
    [144 * 60_000, 180],
  ])('rounds %d ms UP to %d minutes, never down', (ms, minutes) => {
    expect(sayableMinutes(ms)).toBe(minutes);
    expect(sayableMinutes(ms) * 60_000).toBeGreaterThanOrEqual(ms);
  });
});

describe('the late window', () => {
  const asked = new Date('2026-11-20T15:00:00.000Z');

  it('is what is left of the retry ceiling, rounded up', () => {
    const now = new Date(asked.getTime() + 6 * 60_000);
    expect(lateWindowMinutes(asked, now)).toBe(180);
    expect(lateWindowMinutes(asked, now) * 60_000).toBeGreaterThanOrEqual(
      asked.getTime() + retryCeilingMs() - now.getTime(),
    );
  });

  it('never states less than a minute, even past the ceiling', () => {
    const now = new Date(asked.getTime() + retryCeilingMs() + 60_000);
    expect(lateWindowMinutes(asked, now)).toBe(5);
  });
});
