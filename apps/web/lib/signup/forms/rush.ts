/**
 * The only page-level exclusion. Rush and queue sign-ups are the parent's:
 * the runner hands over the open time, the link and the prefilled info.
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

const OPENS_AT =
  /(?:opens|will open|begins|starts)(?:\s+on)?\s+((?:[a-z]+day,?\s+)?(?:[a-z]+\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+(?:\d{4},?\s+)?)?(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?)/i;

/** The open time as the page states it, e.g. `Monday, Jan 5 at 7:00 AM`. */
export function rushOpensAt(text: string): string | null {
  const match = OPENS_AT.exec(text);
  const stated = match?.[1]
    ?.trim()
    .replace(/^at\s+/i, '')
    .replace(/\.$/, '');
  return stated ? stated : null;
}
