import type { BreakPageReader, BreakPageReading, VerifiedBreakReading } from './read';
import type { CalendarSearch } from './search';

/**
 * VIL-685 · one board's winter break for one school year, looked up live: search the
 * board's own host for its calendar, then read the break off each page. The first page
 * that verifies wins. Nothing here guesses: a board whose page names no winter break,
 * whose pages could not be read, or that has no calendar page Hale could find, is
 * `not_found` with the reason named, and the family is asked once instead.
 */

export type BoardNotFoundReason =
  /** The search found no calendar page on the board's host. */
  | 'no_calendar_page'
  /** A page was read and names no winter break for this school year. */
  | 'not_published'
  /** Every page refused, failed to load, or named a break the page does not back. */
  | 'unreadable';

export type BoardLookup =
  | ({ status: 'verified'; boardName: string; sourceUrl: string } & VerifiedBreakReading)
  | {
      status: 'not_found';
      reason: BoardNotFoundReason;
      boardName: string | null;
      /** Each page read and what the reader said, by name. Never page text. */
      tried: Array<{ url: string; outcome: string }>;
    }
  /** The search did not finish, or the reader was busy: ask again soon. */
  | { status: 'retry'; reason: string };

export interface BoardLookupDeps {
  search(officialHost: string, schoolYear: string): Promise<CalendarSearch>;
  read: BreakPageReader;
}

function outcomeName(reading: BreakPageReading): string {
  return 'reason' in reading ? `${reading.status}:${reading.reason}` : reading.status;
}

export async function lookupBoardBreak(
  deps: BoardLookupDeps,
  officialHost: string,
  schoolYear: string,
): Promise<BoardLookup> {
  const search = await deps.search(officialHost, schoolYear);
  if (search.outcome === 'failed') return { status: 'retry', reason: search.reason };
  if (search.outcome === 'none') {
    return { status: 'not_found', reason: 'no_calendar_page', boardName: null, tried: [] };
  }

  const tried: Array<{ url: string; outcome: string }> = [];
  let busy = false;
  let notPublished = false;
  for (const url of search.urls) {
    const reading = await deps.read({ url, officialHost, schoolYear });
    tried.push({ url, outcome: outcomeName(reading) });
    if (reading.status === 'verified') {
      const { name, firstDay, lastDay, sourceUrl } = reading;
      return {
        status: 'verified',
        boardName: search.boardName,
        sourceUrl,
        name,
        firstDay,
        lastDay,
      };
    }
    if (reading.status === 'busy') busy = true;
    if (reading.status === 'not_published') notPublished = true;
  }
  if (busy) return { status: 'retry', reason: 'reader_busy' };
  return {
    status: 'not_found',
    reason: notPublished ? 'not_published' : 'unreadable',
    boardName: search.boardName,
    tried,
  };
}
