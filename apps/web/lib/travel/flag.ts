/**
 * THE TRAVEL BRIEF'S OWN DARK-LAUNCH FLAG — whether Hale may read a booking email at
 * all, and the allowlist that arms it for one household at a time.
 *
 * IT IS NOT F14'S. Two flags, two different questions, both checked and both fail-closed:
 * F14 decides whether Hale may start a conversation with this family at all, and this one
 * decides whether this CLASS of conversation exists. `f14EnabledFor` is read first, the
 * email-alert position.
 *
 * IT GATES DETECTION AS WELL AS THE SEND, and that is the difference from the calendar
 * alert. `calendar_event_snapshots` writes shape while dark because the syncToken advances
 * whether Hale may speak or not — a snapshot is the connector's own bookkeeping. A trip
 * row is not bookkeeping: it is a family's travel plans. So a dark family has nothing read
 * and nothing written, counted as `dark` at the very top of the detect pass, before
 * `looksLikeBooking` is even called and before any Gmail body fetch.
 *
 * WHY THE ALLOWLIST EXISTS, rather than just the boolean. `TRAVEL_BRIEF_ENABLED` is a
 * process-wide env var, so flipping it arms detection for every family `f14EnabledFor`
 * admits — the whole F14 allowlist, or everyone when `F14_ENABLED=true`. The live probe
 * needs exactly one household, and arming it globally to prove one household's feature
 * works would mean reading other households' mailboxes to do it.
 */

export const TRAVEL_BRIEF_ENABLED_ENV = 'TRAVEL_BRIEF_ENABLED';
export const TRAVEL_BRIEF_ALLOWLIST_ENV = 'TRAVEL_BRIEF_FAMILY_ALLOWLIST';

/**
 * STRICT equality on the literal 'true': `vercel env add` from a piped `echo` stores a
 * TRAILING NEWLINE, so a value that prints as `true` is really `'true\n'` — and a
 * truthiness check would read that as ON and start reading booking emails nobody armed.
 * Strict comparison fails closed on exactly that shape. Set it with `printf '%s'`, and
 * redeploy: the value only takes effect on a fresh deployment.
 */
export function travelBriefEnabled(): boolean {
  return process.env[TRAVEL_BRIEF_ENABLED_ENV] === 'true';
}

/** The comma-separated family ids allowed through while the flag is off. */
export function travelBriefAllowlist(): Set<string> {
  return new Set(
    (process.env[TRAVEL_BRIEF_ALLOWLIST_ENV] ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id.length > 0),
  );
}

export function travelBriefEnabledFor(familyId: string): boolean {
  return travelBriefEnabled() || travelBriefAllowlist().has(familyId);
}
