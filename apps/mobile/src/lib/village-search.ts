/**
 * The Village timeframe-search decision layer — the pure counterpart to the
 * search route contract in apps/web/app/api/mobile/village/search/route.ts. A
 * parent picks a future SEASON, POSTs a fresh season-scoped discovery run, then
 * reads it back scoped to that season (coexisting with the standing feed). This
 * module owns the season chips, the read URL, and the state machine mapping a POST
 * outcome → next UI state — no I/O, no RN import, so it is unit-testable off-device
 * (the RN screen is review-only). Every non-success path yields an honest message,
 * never a swallowed null (rule #8). It issues no request and reveals no new
 * location signal — the server already visibility- and teen-filtered the run
 * (rule #1).
 */

/** The four searchable seasons — mirrors SEASONS in apps/web/lib/village/visibility.ts.
 * A stored token never renders raw (rule #1): the chip carries a human label. */
export const SEASON_KEYS = ['spring', 'summer', 'fall', 'winter'] as const;
export type SeasonKey = (typeof SEASON_KEYS)[number];

/** The selector's value: the standing feed, or one future season to search. */
export type SeasonSelection = 'feed' | SeasonKey;

/** The selector chips in row order: the standing feed first, then the four seasons. */
export const SEASON_OPTIONS: ReadonlyArray<{ value: SeasonSelection; label: string }> = [
  { value: 'feed', label: 'your feed' },
  { value: 'spring', label: 'spring' },
  { value: 'summer', label: 'summer' },
  { value: 'fall', label: 'fall' },
  { value: 'winter', label: 'winter' },
];

/** The DiscoverResult the POST returns on 200 — mirrors apps/web/lib/village/discover.ts. */
export type DiscoverResult =
  | { status: 'discovered'; insertedCount: number }
  | { status: 'no_area' }
  | { status: 'no_non_teen_children' };

/** Next UI state after a search attempt: enter search mode reading that season's
 * run, or show an honest error and stay on the current feed. */
export type SearchOutcome =
  | { kind: 'search'; season: SeasonKey; readPath: string }
  | SearchErrorOutcome;

export type SearchErrorOutcome = { kind: 'error'; message: string };

/** The GET that reads a season's search run instead of the standing feed. */
export function searchReadPath(season: SeasonKey): string {
  return `/api/mobile/village?season=${season}`;
}

/**
 * A 200 DiscoverResult → next state. A discovered run (even with zero inserts)
 * enters search mode — the read returns the run and the screen renders the honest
 * empty state if it's empty. A no-area / no-children run can't produce results, so
 * it surfaces the reason instead of a blank search view.
 */
export function searchOutcomeFromResult(season: SeasonKey, result: DiscoverResult): SearchOutcome {
  switch (result.status) {
    case 'discovered':
      return { kind: 'search', season, readPath: searchReadPath(season) };
    case 'no_area':
      return {
        kind: 'error',
        message:
          'Add your area in Family settings first — searches use your coarse area to find nearby activities.',
      };
    case 'no_non_teen_children':
      return { kind: 'error', message: 'No children to search activities for yet.' };
  }
}

/**
 * A failed POST (api() threw) → an honest error line. Takes the plain (status,
 * message) the caller reads off the caught ApiError so this module stays RN-free.
 * A 401 never lands here — the api client redirects to sign-in on 401. The known
 * statuses get a parent-facing line; anything else surfaces the client's own
 * message (network, 503, …) rather than a swallowed null (rule #8).
 */
export function searchOutcomeFromError(status: number, message: string): SearchErrorOutcome {
  switch (status) {
    case 429:
      return { kind: 'error', message: "You've searched a lot — try again shortly." };
    case 400:
      return {
        kind: 'error',
        message: "That season isn't valid — pick spring, summer, fall, or winter.",
      };
    case 403:
      return {
        kind: 'error',
        message: 'Finish setting up your family before searching activities.',
      };
    default:
      return { kind: 'error', message };
  }
}
