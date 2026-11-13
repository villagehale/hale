import type { LiveRegistrationReading, VerifiedRegistrationReading } from '../live-reading';
import type { RegistrationReader, RegistrationTarget } from '../read';
import { type OfficialSite, onOfficialSite } from './official-site';
import { familyOpening } from './opening';
import type { OwnCity } from './place';
import type { PageSearch } from './search';

/**
 * VIL-684 · one city's registration opening for one season, looked up live: establish the
 * city's official site, search for its registration page, keep only the pages on that
 * site, then read the date off each with the VIL-423 reader. The first page that
 * verifies an opening wins. Nothing here guesses: a city whose page says "later", whose
 * page refuses to be read, or that has no official page Hale could find, is `not_found`
 * with the reason named, and the parent hears Hale does not know yet.
 *
 * A read that did not finish (a timeout, a network error, a server error, a model call
 * that failed, Hale out of fetch capacity) says nothing about the page: the lookup is a
 * `retry`, nothing is stored, and the next sweep asks again.
 */

export type CityNotFoundReason =
  /** The structured source names no single official website for this place. */
  | 'no_official_site'
  /** The search named no page on the municipality's official site for this place. */
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
  officialSite(place: OwnCity, now: Date): Promise<OfficialSite>;
  search(place: OwnCity, cycleLabel: string, today: string): Promise<PageSearch>;
  read: RegistrationReader;
}

/** The season as the reader is asked it. A Toronto district names its own morning, the
 * same label the catalog's district rows are read with. */
export function readCycleLabel(place: Pick<OwnCity, 'district'>, cycleLabel: string): string {
  return place.district ? `${cycleLabel} (${place.district.replaceAll('_', ' ')})` : cycleLabel;
}

/** A reading with an opening in it for this family (opening.ts): a preview alone is not
 * a registration date, and a district family needs its district's own date. */
export function opensForFamily(
  reading: VerifiedRegistrationReading,
  place: Pick<OwnCity, 'residencyKnown' | 'district'>,
): boolean {
  return familyOpening(reading, place) !== null;
}

function outcomeName(reading: LiveRegistrationReading): string {
  return 'reason' in reading ? `${reading.status}:${reading.reason}` : reading.status;
}

/** A page that answered and said this season is not out (later, another season only, no
 * date), as opposed to one that could not be read or did not verify. */
export function pageSaysNotYet(
  reading: LiveRegistrationReading,
  place: Pick<OwnCity, 'residencyKnown' | 'district'>,
): boolean {
  if (reading.status === 'verified') return !opensForFamily(reading, place);
  if (reading.status !== 'unverified') return false;
  return (
    reading.reason === 'announced_later' ||
    reading.reason === 'different_cycle_only' ||
    reading.reason === 'not_published' ||
    reading.reason === 'no_dates_for_cycle'
  );
}

/** A read that did not finish: it says nothing about the page, so it is asked again. */
export function readDidNotFinish(reading: LiveRegistrationReading): boolean {
  if (reading.status === 'busy') return true;
  return (
    reading.status === 'unreadable' &&
    (reading.reason === 'timeout' ||
      reading.reason === 'network_error' ||
      reading.reason === 'http_server_error' ||
      reading.reason === 'extract_failed')
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
  const site = await deps.officialSite(place, now);
  if (site.status === 'retry') return { status: 'retry', reason: `official_site:${site.reason}` };
  if (site.status === 'not_found') {
    return { status: 'not_found', reason: 'no_official_site', municipality: null, tried: [] };
  }
  const search = await deps.search(place, cycleLabel, now.toISOString().slice(0, 10));
  if (search.outcome === 'failed') return { status: 'retry', reason: search.reason };
  if (search.outcome === 'none') {
    return { status: 'not_found', reason: 'no_official_page', municipality: null, tried: [] };
  }

  const tried: Array<{ url: string; outcome: string }> = [];
  const official = search.urls.filter((url) => {
    const on = onOfficialSite(url, site);
    if (!on) tried.push({ url, outcome: 'not_official_site' });
    return on;
  });
  if (official.length === 0) {
    return {
      status: 'not_found',
      reason: 'no_official_page',
      municipality: search.municipality,
      tried,
    };
  }
  let unfinished: string | null = null;
  let notYet = false;
  let noYear = false;
  for (const url of official) {
    const reading = await readCityPage(
      deps.read,
      { place, cycleLabel, municipality: search.municipality, sourceUrl: url },
      now,
    );
    tried.push({ url, outcome: outcomeName(reading) });
    if (reading.status === 'verified' && opensForFamily(reading, place)) {
      return { status: 'verified', municipality: search.municipality, sourceUrl: url, reading };
    }
    if (readDidNotFinish(reading)) {
      unfinished ??=
        reading.status === 'busy' || !('reason' in reading)
          ? 'reader_busy'
          : `page_unread:${reading.reason}`;
    }
    if (pageSaysNotYet(reading, place)) notYet = true;
    if (reading.status === 'unverified' && reading.reason === 'incomplete_date') noYear = true;
  }
  if (unfinished !== null) return { status: 'retry', reason: unfinished };
  return {
    status: 'not_found',
    reason: noYear ? 'date_without_year' : notYet ? 'not_published' : 'unreadable',
    municipality: search.municipality,
    tried,
  };
}
