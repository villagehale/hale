import type { SearchActivitiesResult } from './search-action';
import { SEASONS, type Season } from './visibility';

/**
 * The pure decisions behind the season-search UI, kept out of the client
 * component so both can be unit-tested without a render. seasonFromParam scopes
 * the page read; searchResultToUi maps a Server-Action result to the client's
 * next move. Every non-success returns a real message (rule #8), never a null.
 */

/** A valid `?season=` param scopes the page to that season's search run; an
 * unknown or absent param falls back to the standing feed (null). */
export function seasonFromParam(raw: string | undefined): Season | null {
  return raw !== undefined && (SEASONS as readonly string[]).includes(raw) ? (raw as Season) : null;
}

/** Whole minutes left before a throttled search may retry — rounded up so the
 * wait is never understated, floored at 1 so a sub-minute wait still reads. */
export function minutesUntilRetry(retryAfterSec: number): number {
  return Math.max(1, Math.ceil(retryAfterSec / 60));
}

export type SeasonSearchUi =
  | { kind: 'navigate'; season: Season }
  | { kind: 'message'; text: string; link?: { href: string; label: string } };

/**
 * The season-search decision: a real discovery navigates to its search run (the
 * RSC then renders the run — including its own empty state when nothing was
 * found, so "empty" has one source of truth); every other outcome surfaces an
 * honest message in place (rule #8).
 */
export function searchResultToUi(result: SearchActivitiesResult, season: Season): SeasonSearchUi {
  switch (result.status) {
    case 'discovered':
      return { kind: 'navigate', season };
    case 'rate_limited':
      return {
        kind: 'message',
        text: `you've searched a lot — try again in ~${minutesUntilRetry(result.retryAfter)} min.`,
      };
    case 'no_area':
      return {
        kind: 'message',
        text: 'tell Hale where you are — add your area on the family page and Hale can search near you.',
        link: { href: '/family/members', label: 'add your area' },
      };
    case 'no_non_teen_children':
      return {
        kind: 'message',
        text: 'add a child under thirteen and Hale can search for activities to suit their age.',
      };
    case 'no_family':
      return { kind: 'message', text: 'finish setting up your family first.' };
    case 'unauthenticated':
      return { kind: 'message', text: 'sign in to search for activities near you.' };
    default:
      return { kind: 'message', text: 'could not run that search — please try again.' };
  }
}
