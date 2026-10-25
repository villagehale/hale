/** The outbound discriminator for a mid-activity ask. Not the VIL-366 follow-up key. */
export const MID_ACTIVITY_ASK_TEMPLATE_KEY = 'mid-activity:ask';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PREFIX = `${MID_ACTIVITY_ASK_TEMPLATE_KEY}:`;

export function isUuid(value: string): boolean {
  return UUID.test(value);
}

/** An authorized signup's ask. The original key shape, unchanged. */
export function midActivityAskDedupeKey(offerId: string): string {
  return `${PREFIX}${offerId}`;
}

/** What started the activity: a Hale-placed plan, or the parent saying they signed up. */
export type MidActivityStart = 'plan' | 'said';

/**
 * A plan's or a parent-said signup's ask. `occurrence` names this start (the event id,
 * or the first session's local day). `candidateId` is the recommendation it came from,
 * when known, and is what lets the answer reach the next find.
 */
export function midActivityStartDedupeKey(input: {
  start: MidActivityStart;
  occurrence: string;
  candidateId: string | null;
}): string {
  return `${PREFIX}${input.start}:${input.occurrence}:${input.candidateId ?? 'none'}`;
}

export type MidActivityAskRef =
  | { kind: 'signup'; offerId: string }
  | { kind: MidActivityStart; candidateId: string | null };

/** The ref inside a key this module built, or null for anything else. */
export function midActivityAskRef(dedupeKey: string | null): MidActivityAskRef | null {
  if (!dedupeKey?.startsWith(PREFIX)) return null;
  const rest = dedupeKey.slice(PREFIX.length);
  if (UUID.test(rest)) return { kind: 'signup', offerId: rest };
  const [start, occurrence, candidate, ...extra] = rest.split(':');
  if ((start !== 'plan' && start !== 'said') || !occurrence || !candidate || extra.length > 0) {
    return null;
  }
  if (candidate === 'none') return { kind: start, candidateId: null };
  return UUID.test(candidate) ? { kind: start, candidateId: candidate } : null;
}

/** The signup offer inside a key this module built, or null for anything else. */
export function offerIdFromMidActivityDedupeKey(dedupeKey: string | null): string | null {
  const ref = midActivityAskRef(dedupeKey);
  return ref?.kind === 'signup' ? ref.offerId : null;
}
