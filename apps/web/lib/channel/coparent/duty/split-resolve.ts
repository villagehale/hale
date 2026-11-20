import type { DutyOccasion } from './cadence';
import { type SplitPair, findSplitDutyPair } from './overlap';
import { type TravelTimeClient, travelMinutesBetween } from './travel';

const CLOSE_MS = 12 * 60 * 60 * 1000;

/**
 * VIL-661 · travel minutes for one candidate pair, then the soonest clash.
 * A miss from the router is null: overlap then uses clock time only.
 */
export async function resolveSplitDutyPair(
  occasions: readonly DutyOccasion[],
  client: TravelTimeClient,
  opts: { includeSettled?: boolean } = {},
): Promise<SplitPair | null> {
  const cache = new Map<string, number | null>();
  const travelMinutes = (a: DutyOccasion, b: DutyOccasion): number | null => {
    const key = `${a.eventKey}|${b.eventKey}`;
    return cache.get(key) ?? null;
  };

  const live = occasions
    .filter((row) => !row.cancelled && row.source === 'calendar' && !row.needsWhichKid)
    .slice()
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  for (let i = 0; i < live.length; i += 1) {
    const first = live[i];
    if (!first) continue;
    for (let j = i + 1; j < live.length; j += 1) {
      const second = live[j];
      if (!second) continue;
      if (Math.abs(second.startsAt.getTime() - first.startsAt.getTime()) > CLOSE_MS) continue;
      const key = `${first.eventKey}|${second.eventKey}`;
      if (cache.has(key)) continue;
      cache.set(key, await travelMinutesBetween(first.venue, second.venue, client));
    }
  }

  return findSplitDutyPair(occasions, travelMinutes, opts);
}
