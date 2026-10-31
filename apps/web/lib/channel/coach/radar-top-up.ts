import {
  type ActivityPick,
  preferVenuePage,
} from "~/lib/channel/activity/lane";
import { parentFacingActivityUrl } from "~/lib/format/http-url";

/**
 * VIL-522. The coach's `search_village` read is the radar for this turn. Two
 * suitable finds are enough to hand over; fewer than that gets ONE live search
 * to top the list toward three. A second search is the cap — the lane already
 * bounds the searches inside that one call, and this function never calls it
 * twice. Nothing here is a sentence a parent reads.
 */
export const MIN_SUITABLE_FINDS = 2;
export const RADAR_FIND_CAP = 3;

export type RadarTopUpOutcome = "not_needed" | "searched" | "failed";

export interface RadarTopUp {
  picks: ActivityPick[];
  outcome: RadarTopUpOutcome;
}

/** A find the coach can hand over. A Wikipedia (or sister) page is not one.
 * A find with no page yet still is: the program can be real when its URL was
 * not on the snippet. */
export function isSuitableFind(pick: ActivityPick): boolean {
  if (pick.name.trim() === "" || pick.sourceName.trim() === "") return false;
  const raws = [pick.sourceUrl, pick.url].filter(
    (value): value is string => !!value?.trim(),
  );
  if (raws.length === 0) return true;
  return raws.some((raw) => parentFacingActivityUrl(raw) !== null);
}

function pageUrl(pick: ActivityPick): string | null {
  return (
    parentFacingActivityUrl(pick.sourceUrl) ?? parentFacingActivityUrl(pick.url)
  );
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
    .replace(/^the\s+/, "")
    .replace(/[^a-z0-9]/g, "");
}

/** Two values agree when either is missing or they squash to the same thing. */
function agrees(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const left = a?.trim() ? squashName(a) : "";
  const right = b?.trim() ? squashName(b) : "";
  return left === "" || right === "" || left === right;
}

/**
 * The session start a `when` publishes, in minutes after midnight, or null
 * when it names no clock time. "Sat 10am", "Saturday 10:00 AM" and
 * "Saturday 10:00" all read 600; "2pm" and "14:00" read 840.
 */
export function sessionStart(when: string | null | undefined): number | null {
  if (!when?.trim()) return null;
  const match =
    /\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?(?![\d:])/i.exec(when);
  if (!match) return null;
  const [, h, m, ampm] = match;
  if (!m && !ampm) return null; // a bare number ("Nov 7") is not a time
  let hour = Number(h);
  const minute = m ? Number(m) : 0;
  if (hour > 23 || minute > 59) return null;
  if (ampm) {
    if (hour < 1 || hour > 12) return null;
    const pm = ampm.toLowerCase().startsWith("p");
    hour = (hour % 12) + (pm ? 12 : 0);
  }
  return hour * 60 + minute;
}

const WEEKDAYS: Array<[number, RegExp]> = [
  [0, /\bsun(?:day)?s?\b/i],
  [1, /\bmon(?:day)?s?\b/i],
  [2, /\btue(?:s(?:day)?)?s?\b/i],
  [3, /\bwed(?:nesday)?s?\b/i],
  [4, /\bthu(?:r(?:s(?:day)?)?)?s?\b/i],
  [5, /\bfri(?:day)?s?\b/i],
  [6, /\bsat(?:urday)?s?\b/i],
];

/**
 * The weekdays a `when` publishes ("Sat 10am" and "Saturdays 10:00 AM" both
 * read Saturday), as a sorted key; '' when it names none.
 */
export function publishedWeekdays(when: string | null | undefined): string {
  if (!when?.trim()) return "";
  return WEEKDAYS.filter(([, re]) => re.test(when))
    .map(([day]) => day)
    .join(",");
}

/**
 * The same find, not just the same title: names match, and the venue and the
 * date do not disagree. Two venues (or two dates) sharing a title stay two finds.
 */
function sameFind(a: ActivityPick, b: ActivityPick): boolean {
  if (squashName(a.name) !== squashName(b.name)) return false;
  if (a.placeId && b.placeId && a.placeId !== b.placeId) return false;
  if (a.civicVenueId && b.civicVenueId && a.civicVenueId !== b.civicVenueId)
    return false;
  if (!agrees(a.sourceName, b.sourceName)) return false;
  if (!agrees(a.eventDate, b.eventDate)) return false;
  // Structured identity first: a matching event date plus a matching venue id
  // (or named venue) is the same event, however each source wrote `when`.
  const sameDate = !!a.eventDate?.trim() && !!b.eventDate?.trim();
  const sameVenue =
    (!!a.placeId && a.placeId === b.placeId) ||
    (!!a.civicVenueId && a.civicVenueId === b.civicVenueId) ||
    (!!a.sourceName?.trim() &&
      !!b.sourceName?.trim() &&
      squashName(a.sourceName) === squashName(b.sourceName));
  // Both publish a session time: that decides it. Spelling ("Sat 10am" vs
  // "Saturday 10:00 AM") is ignored, but a 10am and a 2pm session stay two.
  // Weekday text only matters when an event date is missing on either side:
  // undated Saturdays 10am and Sundays 10am are two sessions. With the same
  // event date the date decides, so stray weekdays in `when` ("registration
  // opens Monday") never split one session into two.
  if (!sameDate) {
    const daysA = publishedWeekdays(a.when);
    const daysB = publishedWeekdays(b.when);
    if (daysA && daysB && daysA !== daysB) return false;
  }
  const startA = sessionStart(a.when);
  const startB = sessionStart(b.when);
  if (startA !== null && startB !== null) return startA === startB;
  if (sameDate && sameVenue) return true;
  return agrees(a.when, b.when);
}

/**
 * Same find twice: keep the venue's own page when one of the two URLs is it, and
 * keep every known detail (time, price, venue identity) from either copy.
 */
function better(current: ActivityPick, incoming: ActivityPick): ActivityPick {
  const currentUrl = pageUrl(current);
  const incomingUrl = pageUrl(incoming);
  const incomingWins =
    !!incomingUrl &&
    (!currentUrl ||
      preferVenuePage(
        currentUrl,
        incomingUrl,
        current.sourceName || incoming.sourceName,
      ) === incomingUrl);
  const base = incomingWins ? incoming : current;
  const other = incomingWins ? current : incoming;
  const merged: ActivityPick = { ...base };
  if (!merged.when && other.when) merged.when = other.when;
  if (!merged.price && other.price) merged.price = other.price;
  if (!merged.ageFit?.trim() && other.ageFit) merged.ageFit = other.ageFit;
  if (!merged.eventDate && other.eventDate) merged.eventDate = other.eventDate;
  if (!merged.placeId && other.placeId) merged.placeId = other.placeId;
  if (!merged.civicVenueId && other.civicVenueId)
    merged.civicVenueId = other.civicVenueId;
  if (merged.indoorOutdoor == null && other.indoorOutdoor != null) {
    merged.indoorOutdoor = other.indoorOutdoor;
  }
  if (merged.access == null && other.access != null)
    merged.access = other.access;
  return withPage(merged);
}

/**
 * Suitable finds only, radar order first, then live finds that are new.
 * The same find twice (same title, venue, and date) collapses onto the venue page. The list stops at three.
 */
export function mergeTopUp(
  radar: readonly ActivityPick[],
  live: readonly ActivityPick[],
): ActivityPick[] {
  const kept: ActivityPick[] = [];
  const consider = (pick: ActivityPick) => {
    if (!isSuitableFind(pick)) return;
    const at = kept.findIndex((prior) => sameFind(prior, pick));
    if (at === -1) {
      if (kept.length >= RADAR_FIND_CAP) return;
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
    return { picks: mergeTopUp(input.radar, []), outcome: "not_needed" };
  }
  try {
    const live = await input.liveSearch();
    return { picks: mergeTopUp(input.radar, live), outcome: "searched" };
  } catch (err) {
    console.error(
      { err: err instanceof Error ? err.name : "unknown" },
      "coach find: live top-up failed",
    );
    return { picks: mergeTopUp(input.radar, []), outcome: "failed" };
  }
}
