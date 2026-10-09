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

export function claimFailureStep(tries: number): 'error' | 'expired' {
  return tries >= CLAIM_CODE_TRIES ? 'expired' : 'error';
}
