/**
 * The "getting things ready" poll — a pure state model over the real village read
 * (GET /api/mobile/village), so the interstitial's decision to keep waiting, land
 * ready, or time out is unit-tested without a live fetch or a wall clock. It never
 * invents a count: `ready` carries only what the read actually returned.
 */

export const POLL_INTERVAL_MS = 3_000;
export const POLL_TIMEOUT_MS = 45_000;

export type PollState =
  | { kind: 'waiting' }
  | { kind: 'ready'; count: number }
  | { kind: 'timeout' };

/**
 * Decide the next poll state from a fresh read.
 *
 * - Any candidates → ready with the real count (the discovery landed).
 * - No candidates yet, still inside the window → keep waiting.
 * - No candidates and the window has elapsed → timeout (honest "still looking").
 *
 * `elapsedMs` is measured from the first poll, so the timeout is wall-clock
 * bounded regardless of how the reads are scheduled.
 */
export function nextPollState(candidateCount: number, elapsedMs: number): PollState {
  if (candidateCount > 0) {
    return { kind: 'ready', count: candidateCount };
  }
  if (elapsedMs >= POLL_TIMEOUT_MS) {
    return { kind: 'timeout' };
  }
  return { kind: 'waiting' };
}
