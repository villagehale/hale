/**
 * The only page-level exclusion besides the municipal denylist.
 *
 * Any private or commercial booking is in scope until the page shows a
 * rush-registration signal: a waiting room or queue, resident or identity
 * verification, or a timed open-at. Captcha is checked separately from the
 * widget, not from this prose.
 */
export type RushSignal = 'waiting_room' | 'resident_verification' | 'timed_open';

const WAITING = /\bqueue-it\b|\bqueueit\b|waiting room|you are in line|virtual queue|in the queue/;
const RESIDENT =
  /resident id|resident card|residency verification|proof of residency|verify your (identity|residency)|government[- ]issued id|\bgovernment id\b|photo id|driver'?s licen[cs]e|drivers licen[cs]e/;
const TIMED =
  /registration (opens|will open|begins|starts)|booking (opens|will open|begins|starts)|sign-?up opens|enrol+ment opens|(registration|booking|sign-?up).{0,48}opens at\s+\d/;

export function rushSignal(text: string): RushSignal | null {
  const hay = text.toLowerCase();
  if (WAITING.test(hay)) return 'waiting_room';
  if (RESIDENT.test(hay)) return 'resident_verification';
  if (TIMED.test(hay)) return 'timed_open';
  return null;
}
