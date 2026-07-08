import { describe, expect, it } from 'vitest';
import {
  POLL_TIMEOUT_MS,
  type PollState,
  nextPollState,
} from '~/lib/onboarding/village-poll';

/**
 * The "getting things ready" poll decides, from a real village read, whether to
 * keep waiting, land ready (with the ACTUAL count), or time out. Expectations are
 * derived from the spec, not the code's output: any candidate → ready; none within
 * the window → wait; none past the window → honest timeout.
 */
describe('nextPollState', () => {
  it('lands ready with the exact returned count once any candidate exists', () => {
    expect(nextPollState(3, 6_000)).toEqual<PollState>({ kind: 'ready', count: 3 });
  });

  it('lands ready even at the very first poll if discovery already finished', () => {
    expect(nextPollState(1, 0)).toEqual<PollState>({ kind: 'ready', count: 1 });
  });

  it('keeps waiting while empty and still inside the window', () => {
    expect(nextPollState(0, 3_000)).toEqual<PollState>({ kind: 'waiting' });
    expect(nextPollState(0, POLL_TIMEOUT_MS - 1)).toEqual<PollState>({ kind: 'waiting' });
  });

  it('times out honestly when empty at or past the window', () => {
    expect(nextPollState(0, POLL_TIMEOUT_MS)).toEqual<PollState>({ kind: 'timeout' });
    expect(nextPollState(0, POLL_TIMEOUT_MS + 5_000)).toEqual<PollState>({ kind: 'timeout' });
  });

  it('prefers ready over timeout — a result at the deadline still counts', () => {
    expect(nextPollState(2, POLL_TIMEOUT_MS + 10_000)).toEqual<PollState>({
      kind: 'ready',
      count: 2,
    });
  });
});
