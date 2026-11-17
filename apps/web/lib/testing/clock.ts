/**
 * The clock a journey test is allowed to read. `new Date()` follows the wall,
 * so a run inside quiet hours or across midnight asserts a different day than
 * the one the test was written against.
 *
 * `pinnedNow()` is 09:00 in Toronto on a Wednesday, outside quiet hours.
 * `at(iso)` is the same promise for a chosen instant.
 */
export const PINNED_INSTANT = '2026-08-26T13:00:00.000Z';

export function pinnedNow(): Date {
  return new Date(PINNED_INSTANT);
}

/** A fixed instant. The argument is an ISO string, never the wall clock. */
export function at(iso: string): Date {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`pinned clock: not an instant: ${iso}`);
  }
  return date;
}
