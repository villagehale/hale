export const POLL_INTERVAL_MS = 4_000;
export const POLL_WINDOW_MS = 60_000;

export type PollStep = 'refresh' | 'wait' | 'expire';

/** What the pending page does after one status read. A settled answer always refreshes. */
export function nextPollStep(input: { settled: boolean; elapsedMs: number }): PollStep {
  if (input.settled) return 'refresh';
  return input.elapsedMs >= POLL_WINDOW_MS ? 'expire' : 'wait';
}
