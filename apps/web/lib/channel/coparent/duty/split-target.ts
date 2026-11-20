import type { DutyOccasion } from './cadence';
import { dutyStateFromFact } from './model';
import { findSplitDutyPair } from './overlap';

/**
 * VIL-661 · who a split-duty reminder may fire to.
 *
 * Nobody answering means Hale does not assume a driver: both parents' driver
 * reminders stay quiet. A named owner is reminded about their own kid only.
 * A change of mind is live at fire time because this reads the current owner.
 */

export type SplitReminderSuppress = 'split_unassigned' | 'split_other_driver';

export interface SplitTargetEvent {
  eventKey: string;
  childId: string | null;
  kid?: string | null;
  startsAt: Date;
  endsAt?: Date | null;
  ownerUserId: string | null;
}

function asOccasion(row: SplitTargetEvent): DutyOccasion {
  return {
    eventKey: row.eventKey,
    role: 'attend',
    startsAt: row.startsAt,
    endsAt: row.endsAt ?? null,
    hasOwner: Boolean(row.ownerUserId),
    conflict: false,
    needsWhichKid: false,
    cancelled: false,
    hasDutyRecord: row.ownerUserId !== null,
    reasked: false,
    source: 'calendar',
    spokenUserIds: row.ownerUserId ? [row.ownerUserId] : [],
    childId: row.childId,
    kid: row.kid ?? null,
  };
}

/** Confirmed parent owners keyed by the duty event key (a Google calendar id). */
export function confirmedParentDutyOwners(
  facts: readonly { factKey: string; factValue: unknown }[],
): Map<string, string> {
  const owners = new Map<string, string>();
  for (const row of facts) {
    const state = dutyStateFromFact(row.factKey, row.factValue);
    if (state?.status !== 'confirmed' || state.owner?.kind !== 'parent') continue;
    owners.set(state.eventKey, state.owner.userId);
  }
  return owners;
}

export function resolveSplitReminderOwner(
  event: {
    id: string;
    dutyOwnerUserId: string | null;
    googleEventId?: string | null;
    placedGoogleEventId?: string | null;
  },
  ownersByEventKey: ReadonlyMap<string, string>,
): string | null {
  if (event.dutyOwnerUserId) return event.dutyOwnerUserId;
  for (const key of [event.googleEventId, event.placedGoogleEventId, event.id]) {
    if (!key) continue;
    const owner = ownersByEventKey.get(key);
    if (owner) return owner;
  }
  return null;
}

export function splitReminderDecision(input: {
  event: SplitTargetEvent;
  siblings: readonly SplitTargetEvent[];
  parentUserId: string;
  travelMinutes?: (a: DutyOccasion, b: DutyOccasion) => number | null;
}): { action: 'fire' } | { action: 'suppress'; reason: SplitReminderSuppress } {
  const occasions = [input.event, ...input.siblings].map(asOccasion);
  const pair = findSplitDutyPair(occasions, input.travelMinutes ?? (() => null), {
    includeSettled: true,
  });
  if (!pair) return { action: 'fire' };
  if (
    pair.first.eventKey !== input.event.eventKey &&
    pair.second.eventKey !== input.event.eventKey
  ) {
    return { action: 'fire' };
  }
  const owner = input.event.ownerUserId;
  if (!owner) return { action: 'suppress', reason: 'split_unassigned' };
  if (owner !== input.parentUserId) return { action: 'suppress', reason: 'split_other_driver' };
  return { action: 'fire' };
}
