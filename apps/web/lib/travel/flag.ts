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

import { LANE_ENV, laneEnabled } from '../channel/lanes';

export const TRAVEL_BRIEF_ENABLED_ENV = LANE_ENV.travel_brief;
export const TRAVEL_BRIEF_ALLOWLIST_ENV = 'TRAVEL_BRIEF_FAMILY_ALLOWLIST';

/**
 * Read through the shared lane switch, which compares STRICTLY to the literal 'true': a
 * truthiness check would read a piped echo's `'true\n'` as ON and start reading booking
 * emails nobody armed. `lanes.ts` documents that shape and how to set the value.
 */
export function travelBriefEnabled(): boolean {
  return laneEnabled('travel_brief');
}

/** The comma-separated family ids the brief is narrowed to while the lane is on. */
export function travelBriefAllowlist(): Set<string> {
  return new Set(
    (process.env[TRAVEL_BRIEF_ALLOWLIST_ENV] ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id.length > 0),
  );
}

export function travelBriefEnabledFor(familyId: string): boolean {
  // The lane is the kill: off is off for every household. While it is on, a non-empty
  // allowlist narrows the brief to the listed households (one household to prove).
  if (!travelBriefEnabled()) return false;
  const allowlist = travelBriefAllowlist();
  return allowlist.size === 0 || allowlist.has(familyId);
}
