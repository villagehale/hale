/**
 * Rule #11 for the portal's external reads: an absent credential and a dead
 * provider are first-class outcomes with names, never a silent empty array.
 * Every service client returns this union; every panel renders all three arms
 * (data / "not set" / "didn't answer") with its external link intact.
 */
export type ServiceOutcome<T> =
  | { ok: true; data: T }
  | { ok: false; status: 'not_configured'; detail: string }
  | { ok: false; status: 'unreachable'; detail: string };

export const SERVICE_TIMEOUT_MS = 5_000;

/** A refusal's one-line detail — status text only, never a response body. */
export function unreachable<T>(detail: string): ServiceOutcome<T> {
  return { ok: false, status: 'unreachable', detail };
}

export function notConfigured<T>(detail: string): ServiceOutcome<T> {
  return { ok: false, status: 'not_configured', detail };
}
