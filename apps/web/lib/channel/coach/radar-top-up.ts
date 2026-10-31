import { type ActivityPick, preferVenuePage } from '~/lib/channel/activity/lane';
import { parentFacingActivityUrl } from '~/lib/format/http-url';

/**
 * VIL-522. The coach's `search_village` read is the radar for this turn. Two
 * suitable finds are enough to hand over; fewer than that gets ONE live search
 * to top the list toward three. A second search is the cap — the lane already
 * bounds the searches inside that one call, and this function never calls it
 * twice. Nothing here is a sentence a parent reads.
 */
export const MIN_SUITABLE_FINDS = 2;
export const RADAR_FIND_CAP = 3;

export type RadarTopUpOutcome = 'not_needed' | 'searched' | 'failed';

export interface RadarTopUp {
  picks: ActivityPick[];
  outcome: RadarTopUpOutcome;
}

/** A find the coach can hand over. A Wikipedia (or sister) page is not one.
 * A find with no page yet still is: the program can be real when its URL was
 * not on the snippet. */
export function isSuitableFind(pick: ActivityPick): boolean {
  if (pick.name.trim() === '' || pick.sourceName.trim() === '') return false;
  const raws = [pick.sourceUrl, pick.url].filter((value): value is string => !!value?.trim());
  if (raws.length === 0) return true;
  return raws.some((raw) => parentFacingActivityUrl(raw) !== null);
}

function pageUrl(pick: ActivityPick): string | null {
  return parentFacingActivityUrl(pick.sourceUrl) ?? parentFacingActivityUrl(pick.url);
}

function withPage(pick: ActivityPick): ActivityPick {
  const url = pageUrl(pick);
  if (!url) {
    const { url: _dropUrl, sourceUrl: _dropSource, ...rest } = pick;
    return rest;
  }
  return { ...pick, url, sourceUrl: url };
}

function squashName(value: string): string {
  return value
    .toLowerCase()
    .replace(/^the\s+/, '')
    .replace(/[^a-z0-9]/g, '');
}

/** Same find twice: keep the venue's own page when one of the two URLs is it. */
function better(current: ActivityPick, incoming: ActivityPick): ActivityPick {
  const currentUrl = pageUrl(current);
  const incomingUrl = pageUrl(incoming);
  if (!incomingUrl) return withPage(current);
  if (!currentUrl) return withPage(incoming);
  const chosen = preferVenuePage(
    currentUrl,
    incomingUrl,
    current.sourceName || incoming.sourceName,
  );
  return chosen === incomingUrl ? withPage(incoming) : withPage(current);
}

/**
 * Suitable finds only, radar order first, then live finds that are new.
 * Duplicates collapse onto the venue page. The list stops at three.
 */
export function mergeTopUp(
  radar: readonly ActivityPick[],
  live: readonly ActivityPick[],
): ActivityPick[] {
  const kept: ActivityPick[] = [];
  const indexByName = new Map<string, number>();
  const consider = (pick: ActivityPick) => {
    if (!isSuitableFind(pick)) return;
    const key = squashName(pick.name);
    const at = indexByName.get(key);
    if (at === undefined) {
      if (kept.length >= RADAR_FIND_CAP) return;
      indexByName.set(key, kept.length);
      kept.push(withPage(pick));
      return;
    }
    const prior = kept[at];
    if (prior) kept[at] = better(prior, pick);
  };
  for (const pick of radar) consider(pick);
  for (const pick of live) consider(pick);
  return kept;
}

/**
 * One live search when the radar is short of two suitable finds, and none
 * otherwise. A throw is named `failed` and the radar finds still come back —
 * the search having failed is not an empty radar.
 */
export async function topUpShortRadar(input: {
  radar: readonly ActivityPick[];
  liveSearch: () => Promise<readonly ActivityPick[]>;
}): Promise<RadarTopUp> {
  const suitable = input.radar.filter(isSuitableFind);
  if (suitable.length >= MIN_SUITABLE_FINDS) {
    return { picks: mergeTopUp(input.radar, []), outcome: 'not_needed' };
  }
  try {
    const live = await input.liveSearch();
    return { picks: mergeTopUp(input.radar, live), outcome: 'searched' };
  } catch (err) {
    console.error(
      { err: err instanceof Error ? err.name : 'unknown' },
      'coach find: live top-up failed',
    );
    return { picks: mergeTopUp(input.radar, []), outcome: 'failed' };
  }
}
