import { formatCalendarDate, formatWhenPhrase } from '~/lib/format/datetime';
import {
  type LiveRegistrationDate,
  type VerifiedRegistrationReading,
  registrationAnchor,
} from '../live-reading';

/**
 * VIL-684 · which of a city page's openings is THIS family's, and how it is said.
 *
 * The page is the family's own city's (the search named the municipality the family's
 * place belongs to), so an opening the page labels for residents is theirs, and so is an
 * opening it attaches no eligibility label to: whether that one is for everyone or for
 * residents first, a resident may register on it. Where residency is in doubt (an FSA
 * on a town line), only the opening the page labels for everyone is claimed: telling a
 * family they can register a day early when they cannot is the expensive mistake.
 */
export interface FamilyOpening {
  own: LiveRegistrationDate;
  /** The later opening for everyone else, when it differs from `own`. */
  general: LiveRegistrationDate | null;
}

export function familyOpening(
  reading: VerifiedRegistrationReading,
  residencyKnown: boolean,
): FamilyOpening | null {
  const of = (kind: LiveRegistrationDate['kind']) => reading.dates.find((d) => d.kind === kind);
  const general = of('general_open') ?? null;
  const own = residencyKnown
    ? (of('resident_open') ?? of('unclassified_open') ?? general)
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
