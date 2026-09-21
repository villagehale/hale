/**
 * BOOKED DETECTION's own dark-launch flag — whether a `booking_confirmation` is treated
 * as a booking at all, and the allowlist that arms it for one household at a time.
 *
 * IT IS NOT F14'S AND NOT THE FOLLOW-UP SWEEP'S. Three flags, three different questions:
 * F14 decides whether Hale may start a conversation (the alert itself is gated on it
 * first), `FOLLOWUP_ASKS_ENABLED` decides whether Hale may check back on anything, and
 * this one decides whether a receipt is a fact Hale will act on a week later. None is a
 * substitute for another.
 *
 * WHAT IT GATES, at three depths:
 *   · the booking FRAME and its CTA — dark, a `booking_confirmation` renders through the
 *     `new_event` twins, byte-identical to what that email produces today;
 *   · `OFFERED_TIME` — dark, it maps to `event.newTime` exactly as `new_event` does, so
 *     the offer path behaves identically;
 *   · the booking ROW — dark, none is written, which makes the follow-up widening dark
 *     for free with nothing left over.
 *
 * WHAT IT DELIBERATELY CANNOT GATE. The kind stays in `EXTRACTION_KINDS` in both states
 * (a flag that changed what the model may return would invalidate the eval cache on every
 * flip), and the triage skill's widening is a prompt rather than a runtime branch — so
 * merging makes `booking_confirmation` reachable for every F14 family regardless. What
 * the flag stops is everything after. The observable delta with it off is bounded: at
 * most ten extra Sonnet extractions per connection per 15-minute sweep, because
 * EMAIL_ALERT_MAX_PER_SWEEP is applied before any model call.
 */

export const BOOKED_DETECTION_ENABLED_ENV = 'BOOKED_DETECTION_ENABLED';
export const BOOKED_DETECTION_ALLOWLIST_ENV = 'BOOKED_DETECTION_FAMILY_ALLOWLIST';

/**
 * STRICT equality on the literal 'true': `vercel env add` from a piped `echo` stores a
 * TRAILING NEWLINE, so a value that prints as `true` is really `'true\n'` — and a
 * truthiness check would read that as ON and start writing rows nobody armed. Strict
 * comparison fails closed on exactly that shape.
 */
export function bookedDetectionEnabled(): boolean {
  return process.env[BOOKED_DETECTION_ENABLED_ENV] === 'true';
}

/** The comma-separated family ids allowed through while the flag is off. */
export function bookedDetectionAllowlist(): Set<string> {
  return new Set(
    (process.env[BOOKED_DETECTION_ALLOWLIST_ENV] ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id.length > 0),
  );
}

export function bookedDetectionEnabledFor(familyId: string): boolean {
  return bookedDetectionEnabled() || bookedDetectionAllowlist().has(familyId);
}
