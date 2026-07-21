/**
 * Pure helpers for the passwordless magic-link flow, factored out of the screens so
 * the client-side email check, the deep-link token extraction, and the verify
 * screen's initial phase are unit-testable without a native runtime.
 */

/**
 * A deliberately lenient client-side plausibility check — the server is the
 * authority. It only blocks the obvious mistakes (empty, no `@`, no domain dot,
 * embedded whitespace) so we never fire a request for "" or "parent".
 */
export function isPlausibleEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

/**
 * expo-router hands a query param as string | string[] | undefined. The magic link
 * carries exactly one `token`; take the first, trim it, and treat empty as missing
 * so the screen renders the failure state instead of POSTing "".
 */
export function magicTokenFromParams(token: string | string[] | undefined): string | null {
  const raw = Array.isArray(token) ? token[0] : token;
  const trimmed = raw?.trim();
  return trimmed ? trimmed : null;
}

export type MagicPhase = 'verifying' | 'failed';

/**
 * The verify screen starts verifying only when a token is present; a missing or
 * empty token is an immediate failure — there is nothing to redeem.
 */
export function initialMagicPhase(token: string | null): MagicPhase {
  return token ? 'verifying' : 'failed';
}

/**
 * Whether the verify screen should (re)attempt a token, given the token it last acted
 * on. A fresh token is attempted — including one that deep-links in while a prior
 * attempt already failed, which is what re-verifies a second link tapped on the
 * "Link didn't work" screen instead of leaving it stuck failed. The token already
 * acted on is not re-fired, and a missing token is nothing to redeem.
 */
export function shouldAttemptToken(
  token: string | null,
  lastAttempted: string | null,
): token is string {
  return token !== null && token !== lastAttempted;
}
