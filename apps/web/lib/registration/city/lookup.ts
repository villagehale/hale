import type { LiveRegistrationReading, VerifiedRegistrationReading } from '../live-reading';
import type { RegistrationReader, RegistrationTarget } from '../read';
import type { OwnCity } from './place';
import type { PageSearch } from './search';

/**
 * VIL-684 · one city's registration opening for one season, looked up live: search for
 * the city's own page, then read the date off that page with the VIL-423 reader. The
 * first page that verifies an opening wins. Nothing here guesses: a city whose page
 * says "later", whose page could not be read, or that has no page Hale could find, is
 * `not_found` with the reason named, and the parent hears Hale does not know yet.
 */

export type CityNotFoundReason =
  /** The search named no page the municipality publishes for this place. */
  | 'no_official_page'
  /** A page was read and does not publish this season's opening yet. */
  | 'not_published'
  /** A page prints this season's opening without its year. The stale-year rule reads no
   * year a page does not state, so it is not a date yet (Toronto's table, 2026-11-12). */
  | 'date_without_year'
  /** Every page refused or failed to load, or its dates did not verify. */
  | 'unreadable';

export type CityLookup =
  | {
      status: 'verified';
      municipality: string;
      sourceUrl: string;
      reading: VerifiedRegistrationReading;
    }
  | {
      status: 'not_found';
      reason: CityNotFoundReason;
      municipality: string | null;
      /** Each page read and what the reader said, by name. Never page text. */
      tried: Array<{ url: string; outcome: string }>;
    }
  /** The search did not finish, or Hale was out of fetch capacity: ask again soon. */
  | { status: 'retry'; reason: string };

export interface CityLookupDeps {
  search(place: OwnCity, cycleLabel: string, today: string): Promise<PageSearch>;
  read: RegistrationReader;
}

/** The season as the reader is asked it. A Toronto district names its own morning, the
 * same label the catalog's district rows are read with. */
export function readCycleLabel(place: Pick<OwnCity, 'district'>, cycleLabel: string): string {
  return place.district ? `${cycleLabel} (${place.district.replaceAll('_', ' ')})` : cycleLabel;
}

/** A reading with an opening in it. A preview alone is not a registration date. */
function hasOpening(reading: VerifiedRegistrationReading): boolean {
  return reading.dates.some((date) => date.kind !== 'preview');
}

function outcomeName(reading: LiveRegistrationReading): string {
  return 'reason' in reading ? `${reading.status}:${reading.reason}` : reading.status;
}

/** A page that answered and said this season is not out (later, another season only, no
 * date), as opposed to one that could not be read or did not verify. */
function saysNotYet(reading: LiveRegistrationReading): boolean {
  if (reading.status === 'verified') return !hasOpening(reading);
  if (reading.status !== 'unverified') return false;
  return (
    reading.reason === 'announced_later' ||
    reading.reason === 'different_cycle_only' ||
    reading.reason === 'not_published' ||
    reading.reason === 'no_dates_for_cycle'
  );
}

/** Re-read one known page: the cheap re-verify of a city whose page Hale already has. */
export async function readCityPage(
  read: RegistrationReader,
  input: { place: OwnCity; cycleLabel: string; municipality: string; sourceUrl: string },
  now: Date,
): Promise<LiveRegistrationReading> {
  const target: RegistrationTarget = {
    municipality: input.municipality,
    programDomain: 'rec_program',
    cycleLabel: readCycleLabel(input.place, input.cycleLabel),
    sourceUrl: input.sourceUrl,
  };
  return read(target, now);
}

export async function lookupCityRegistration(
  deps: CityLookupDeps,
  place: OwnCity,
  cycleLabel: string,
  now: Date,
): Promise<CityLookup> {
  const search = await deps.search(place, cycleLabel, now.toISOString().slice(0, 10));
  if (search.outcome === 'failed') return { status: 'retry', reason: search.reason };
  if (search.outcome === 'none') {
    return { status: 'not_found', reason: 'no_official_page', municipality: null, tried: [] };
  }

  const tried: Array<{ url: string; outcome: string }> = [];
  let busy = false;
  let notYet = false;
  let noYear = false;
  for (const url of search.urls) {
    const reading = await readCityPage(
      deps.read,
      { place, cycleLabel, municipality: search.municipality, sourceUrl: url },
      now,
    );
    tried.push({ url, outcome: outcomeName(reading) });
    if (reading.status === 'verified' && hasOpening(reading)) {
      return { status: 'verified', municipality: search.municipality, sourceUrl: url, reading };
    }
    if (reading.status === 'busy') busy = true;
    if (saysNotYet(reading)) notYet = true;
    if (reading.status === 'unverified' && reading.reason === 'incomplete_date') noYear = true;
  }
  if (busy) return { status: 'retry', reason: 'reader_busy' };
  return {
    status: 'not_found',
    reason: noYear ? 'date_without_year' : notYet ? 'not_published' : 'unreadable',
    municipality: search.municipality,
    tried,
  };
}
