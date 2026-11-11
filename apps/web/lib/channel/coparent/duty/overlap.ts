import type { DutyOccasion } from './cadence';

/**
 * VIL-661 · two different kids, same household, overlapping in clock time or
 * in the gap after travel between real venue addresses.
 *
 * Same-child clashes stay on VIL-609. A pair already split across two owners
 * is settled. Hale does not invent a kid when the occasion names none.
 */

export interface SplitPair {
  first: DutyOccasion;
  second: DutyOccasion;
  travelMinutes: number | null;
}

export function eventsConflictWithTravel(
  a: { startsAt: Date; endsAt?: Date | null },
  b: { startsAt: Date; endsAt?: Date | null },
  travelMinutes: number | null,
): boolean {
  const aStart = a.startsAt.getTime();
  const aEnd = (a.endsAt ?? a.startsAt).getTime();
  const bStart = b.startsAt.getTime();
  const bEnd = (b.endsAt ?? b.startsAt).getTime();
  if (aStart < bEnd && bStart < aEnd) return true;
  const travelMs = Math.max(0, travelMinutes ?? 0) * 60_000;
  if (travelMs === 0) return false;
  if (aEnd <= bStart) return bStart - aEnd < travelMs;
  if (bEnd <= aStart) return aStart - bEnd < travelMs;
  return false;
}

function kidKey(row: DutyOccasion): string | null {
  const id = row.childId?.trim();
  if (id) return `id:${id}`;
  const name = row.kid?.trim().toLowerCase();
  if (name && name.length >= 2) return `name:${name}`;
  return null;
}

function ownerKey(row: DutyOccasion): string | null {
  if (!row.hasOwner) return null;
  const spoken = row.spokenUserIds ?? [];
  if (spoken.length === 1 && spoken[0]) return spoken[0];
  return row.spokenName?.trim().toLowerCase() || 'owned';
}

function alreadySplit(a: DutyOccasion, b: DutyOccasion): boolean {
  const left = ownerKey(a);
  const right = ownerKey(b);
  return left !== null && right !== null && left !== right;
}

function bothOwnedBySame(a: DutyOccasion, b: DutyOccasion): boolean {
  const left = ownerKey(a);
  const right = ownerKey(b);
  return left !== null && right !== null && left === right;
}

function speakableSplit(row: DutyOccasion): boolean {
  return !row.cancelled && row.source === 'calendar' && !row.needsWhichKid;
}

export interface FindSplitDutyPairOptions {
  /**
   * Include a pair that already has owners (a settled split or one parent taking
   * both). Used to read a change of mind. Default skips those.
   */
  includeSettled?: boolean;
}

/**
 * The soonest pair of different-kid occasions one parent cannot cover.
 * Already-split pairs and "one parent already takes both" are skipped unless
 * `includeSettled` is set.
 */
export function findSplitDutyPair(
  occasions: readonly DutyOccasion[],
  travelMinutes: (a: DutyOccasion, b: DutyOccasion) => number | null,
  opts: FindSplitDutyPairOptions = {},
): SplitPair | null {
  const live = occasions
    .filter(speakableSplit)
    .slice()
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  for (let i = 0; i < live.length; i += 1) {
    const first = live[i];
    if (!first) continue;
    const firstKid = kidKey(first);
    if (!firstKid) continue;
    for (let j = i + 1; j < live.length; j += 1) {
      const second = live[j];
      if (!second) continue;
      const secondKid = kidKey(second);
      if (!secondKid || secondKid === firstKid) continue;
      if (!opts.includeSettled && (alreadySplit(first, second) || bothOwnedBySame(first, second))) {
        continue;
      }
      const travel = travelMinutes(first, second);
      if (!eventsConflictWithTravel(first, second, travel)) continue;
      return { first, second, travelMinutes: travel };
    }
  }
  return null;
}
