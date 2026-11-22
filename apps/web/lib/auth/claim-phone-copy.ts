/**
 * Parent-facing phone sign-in strings. Shared so the server action and the
 * form agree, and so a wrong code stays one message for every number (an
 * account oracle would be a different sentence per outcome).
 *
 * Expiry is NOT a server distinction. The form shows "Time for a new code"
 * from a client timer and a local try count, which are true for any number.
 */

export const CLAIM_CODE_ERROR = "That code didn't work. Try again, or send a new one.";

export const CLAIM_RATE_LIMIT = 'Too many tries. Wait a few minutes, then try again.';

export const CLAIM_NUMBER_ERROR = "That didn't go through. Check the number and try again.";

export const CLAIM_CONNECTION_ERROR =
  "That didn't go through. Check your connection and try again.";

/** Codes work for 10 minutes or three tries — the expired screen's own rule. */
export const CLAIM_CODE_TTL_MS = 10 * 60 * 1000;
export const CLAIM_CODE_TRIES = 3;

/**
 * The code step's note. A number that asked to stop is sent no code, and it is re-enrolled
 * when it texts Hale that it wants back in, in any wording (the opt-out reader's `start`,
 * `restartFromReader` in the intake machine). `noStopKeyword` is
 * NO_STOP_KEYWORD_COPY_ENABLED, read on the server and passed in.
 */
export function claimCodeNote(noStopKeyword: boolean): string {
  return noStopKeyword
    ? 'Nothing yet? It can take a minute. If you once told Hale to stop texting you, text Hale that you want to start again, in your own words, then send a new code.'
    : 'Nothing yet? It can take a minute. If you once replied STOP to Hale, reply START in that thread first.';
}

export function claimFailureStep(tries: number): 'error' | 'expired' {
  return tries >= CLAIM_CODE_TRIES ? 'expired' : 'error';
}
