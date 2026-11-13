import { namesAny } from '@hale/types';
import { formatCalendarDate, formatWhenPhrase } from '~/lib/format/datetime';
import type { TorontoDistrict } from '../fsa-municipalities';
import {
  type LiveRegistrationDate,
  type VerifiedRegistrationReading,
  registrationAnchor,
} from '../live-reading';
import type { OwnCity } from './place';

/**
 * VIL-684 · which of a city page's openings is THIS family's, and how it is said.
 *
 * The page is the family's own city's (its host is the municipality's official site), so
 * an opening the page labels for residents is theirs, then the opening for everyone, and
 * only then one the page attaches no eligibility label to: a resident may register on any
 * of them. Where residency is in doubt (an FSA on a town line), only the opening the page
 * labels for everyone is claimed: telling a family they can register a day early when
 * they cannot is the expensive mistake.
 *
 * A family whose district registers on its own morning (Toronto) takes only a date the
 * page ties to that district: an opening for everyone or an unlabelled one whose own
 * words name the district. Never a residents' morning (Toronto's "eligible residents"
 * early-local morning is not the district's), and never an unlabelled date that names no
 * district (a free-centres morning is not North York's).
 */
export interface FamilyOpening {
  own: LiveRegistrationDate;
  /** The later opening for everyone else, when it differs from `own`. */
  general: LiveRegistrationDate | null;
}

/** The date's own page words name every word of the district's name, each as a whole
 * word (the shared whole-word matcher). */
export function namesDistrict(date: LiveRegistrationDate, district: TorontoDistrict): boolean {
  const name = district.split('_');
  return date.evidence.some((quote) => name.every((word) => namesAny(quote, [word])));
}

export function familyOpening(
  reading: VerifiedRegistrationReading,
  place: Pick<OwnCity, 'residencyKnown' | 'district'>,
): FamilyOpening | null {
  const of = (kind: LiveRegistrationDate['kind']) => reading.dates.find((d) => d.kind === kind);
  const { district } = place;
  if (district !== null) {
    const own = [of('general_open'), of('unclassified_open')].find(
      (date) => date !== undefined && namesDistrict(date, district),
    );
    return own ? { own, general: null } : null;
  }
  const general = of('general_open') ?? null;
  const own = place.residencyKnown
    ? (of('resident_open') ?? general ?? of('unclassified_open'))
    : general;
  if (!own) return null;
  return { own, general: general !== null && general !== own ? general : null };
}

/** The instant a date opens at, in the page's own zone (the family's city). */
export function openingInstant(reading: VerifiedRegistrationReading, date: LiveRegistrationDate) {
  return registrationAnchor(reading, date);
}

/**
 * The date as a parent reads it: `Dec 8, 7:00 a.m.` where the page printed a time, and
 * `Dec 8` alone where it did not. A date-only opening is anchored at the start of its
 * day; rendering that anchor's clock would state a time the page never printed.
 */
export function openingPhrase(
  reading: VerifiedRegistrationReading,
  date: LiveRegistrationDate,
  now: Date,
): string {
  if (date.time === null) return formatCalendarDate(`${date.date}T00:00:00Z`, now);
  return formatWhenPhrase(openingInstant(reading, date), reading.timeZone, now);
}
