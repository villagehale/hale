/**
 * VIL-226 · an alert, not a cap. A family past this many proactive sends in a
 * day is unusual enough to page #ops. The send is not held.
 *
 * Twelve is the line: the old per-kind counters could add up to about eighteen
 * texts a day, so twelve is a bug or a runaway, not a busy Tuesday.
 */

export const UNUSUAL_FAMILY_VOLUME = 12;

export function volumeIsUnusual(sendsInWindow: number): boolean {
  return sendsInWindow >= UNUSUAL_FAMILY_VOLUME;
}
