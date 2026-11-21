import { CHANNEL_MESSAGE_RECEIVED_RETRY, TURN_DEADLINE_MS } from '~/lib/channel/config';

/**
 * VIL-717 · the times an ack and a late note may state, computed from the queue's own
 * settings rather than chosen. They are FACTS the writer is handed, so "never a promise
 * Hale cannot keep" is a property of these numbers, not of a sentence.
 *
 * A slow text is answered inside its own turn, which runs for at most
 * {@link TURN_DEADLINE_MS}. A turn that runs out goes back to the queue: pg-boss schedules
 * the nth retry somewhere in `[delay·2^(n-1), delay·2^n)` seconds, the every-minute drain
 * picks it up, and it runs again. Past the last retry the job dead-letters and #ops is paged
 * (channel/config.ts), so the retry ceiling is the latest any answer to that text can come.
 */

/** The scheduled drain runs every minute, so a retry that is due waits at most this long. */
export const DRAIN_PICKUP_MS = 60_000;

/** The longest wait pg-boss may put before retry `n` (1-based), in milliseconds. */
function longestBackoffMs(n: number): number {
  return CHANNEL_MESSAGE_RECEIVED_RETRY.retryDelay * 2 ** n * 1000;
}

/**
 * The window an ack states, in whole minutes: the turn it was sent from, the first retry's
 * longest backoff, one drain pickup, and the retried turn. A reply inside it is on time.
 * With today's settings that is 90s + 30s + 60s + 90s = 4.5 min, so five minutes.
 */
export function ackWindowMinutes(): number {
  const ms = TURN_DEADLINE_MS + longestBackoffMs(1) + DRAIN_PICKUP_MS + TURN_DEADLINE_MS;
  return Math.ceil(ms / 60_000);
}

/**
 * The latest an answer to a text can still come, counted from when the text arrived: every
 * retry's longest backoff, plus a turn and a pickup for each attempt. With today's settings
 * that is 7650s of backoff and nine attempts of 150s, so 150 minutes.
 */
export function retryCeilingMs(): number {
  let backoff = 0;
  for (let n = 1; n <= CHANNEL_MESSAGE_RECEIVED_RETRY.retryLimit; n += 1) {
    backoff += longestBackoffMs(n);
  }
  const attempts = CHANNEL_MESSAGE_RECEIVED_RETRY.retryLimit + 1;
  return backoff + attempts * (TURN_DEADLINE_MS + DRAIN_PICKUP_MS);
}

/**
 * A remaining time, as minutes a person would say, always rounded UP so the stated window
 * is never shorter than the true one: five-minute steps up to an hour, whole hours above.
 */
export function sayableMinutes(ms: number): number {
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  if (minutes <= 60) return Math.ceil(minutes / 5) * 5;
  return Math.ceil(minutes / 60) * 60;
}

/**
 * The new window a late note may state for a text that is still being retried: what is left
 * of the retry ceiling at `now`, said as a person would say it.
 */
export function lateWindowMinutes(askedAt: Date, now: Date): number {
  const left = askedAt.getTime() + retryCeilingMs() - now.getTime();
  return sayableMinutes(Math.max(left, 60_000));
}
