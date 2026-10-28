import { matchPostalToken } from '~/lib/channel/off-domain/place';
import { deriveAreaCoarse } from '~/lib/family/location-input';
import type { AgePrecision, ExtractedChild } from './extract';
import { timezoneForIntakePostal } from './postal-zone';

/**
 * VIL-237 · M2 — the pure derivations between "what the parent texted" and "what gets
 * written". No I/O, no model, no DB: everything here is checkable against the spec.
 */

/**
 * Where a postal token places a family. The FSA is always known; the full code only
 * when the parent volunteered one. Decision D2: the FSA is what discovery actually
 * runs on (the M1 matcher keys on it), so the second half is a later just-in-time ask
 * and never a precondition for setting a family up.
 */
export interface PostalContext {
  postalCode: string | null;
  areaCoarse: string;
  /** Display name stored on `families.country` (`Canada` or `United States`). */
  country: 'Canada' | 'United States';
  countryCode: 'CA' | 'US';
  /** IANA zone derived from the code. Never a Toronto default. */
  timezone: string;
}

/**
 * A Canadian postal code (FSA, LDU optional) or a US ZIP / ZIP+4. The shape comes
 * from the off-domain postal tables; the coarse area from the family location helper
 * (FSA, or ZIP3). Null means the token is not a US or Canadian code — a UK postcode,
 * a city name — and the model writes the reply. Nothing here guesses a country.
 */
export function parseIntakePostal(raw: string | null): PostalContext | null {
  if (!raw) return null;
  const matched = matchPostalToken(raw);
  if (!matched) return null;
  const stored = matched.postalCode ?? matched.areaKey;
  const areaCoarse = deriveAreaCoarse(stored, null);
  if (!areaCoarse) return null;
  return {
    postalCode: matched.postalCode,
    areaCoarse,
    country: matched.countryName === 'United States' ? 'United States' : 'Canada',
    countryCode: matched.country,
    timezone: timezoneForIntakePostal(matched.country, matched.areaKey),
  };
}

/**
 * Months to add to a stated age to reach the MIDPOINT of the band that statement
 * actually covers. This is the entire reason {@link AgePrecision} exists.
 *
 * "She's four" means anywhere in the 12 months before her fifth birthday, so the
 * midpoint — six months on — is the estimate with the smallest worst-case error (±6
 * instead of −0/+12 if we took the birthday as today). "18 months" is not that: the
 * parent already did the narrowing, and 18 IS their estimate. Adding six to it stores
 * a two-year-old, and no consumer can tell afterwards, because they all read the age
 * back out of the date.
 */
const MIDPOINT_CORRECTION_MONTHS: Record<AgePrecision, number> = { years: 6, months: 0 };

/**
 * The stored date_of_birth for a child whose parent gave only an AGE. The row is
 * stamped `dob_precision = 'derived'` so nothing downstream can mistake this for a
 * birthday — that stamp is what earns the ±6-month early-edge tolerance in the
 * registration and health matchers.
 */
export function deriveDateOfBirth(ageMonths: number, precision: AgePrecision, now: Date): string {
  const months = ageMonths + MIDPOINT_CORRECTION_MONTHS[precision];
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() - months;
  // Day 0 of the month AFTER the target is the target's last day. Clamping to it is
  // what keeps the round trip exact: `Date.UTC` rolls the 31st of a 30-day month
  // FORWARD into the next one, which stores a later birthday than the parent stated
  // and reads the child back a month YOUNGER than they are — for every signup on the
  // 29th to the 31st. `ageInMonths` already clamps the anniversary the same way, so
  // the two agree on what "the same day of a shorter month" means.
  const lastDayOfTargetMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const day = Math.min(now.getUTCDate(), lastDayOfTargetMonth);
  const dob = new Date(Date.UTC(year, month, day));
  return dob.toISOString().slice(0, 10);
}

/** "Maya (4)" — years, because that is how the parent said it. A child with no name
 * is referred to the way the parent referred to them. */
function describeChild(child: ExtractedChild): string {
  const years = child.ageMonths === null ? null : Math.floor(child.ageMonths / 12);
  // Under a year the years floor is 0, and "Maya (0)" reads back an age nobody said —
  // on a line that is also handed to the composer as a grounded fact. A parent who
  // narrowed to months gets their own unit back, the same way the unnamed branch below
  // says "your baby" rather than "your 0-year-old".
  if (child.name && child.ageMonths !== null && years === 0) {
    return `${child.name} (${monthsLabel(child.ageMonths)})`;
  }
  if (child.name && years !== null) return `${child.name} (${years})`;
  if (child.name) return child.name;
  if (years !== null) return years === 0 ? 'your baby' : `your ${years}-year-old`;
  return 'your little one';
}

function monthsLabel(months: number): string {
  if (months === 0) return 'newborn';
  return months === 1 ? '1 month' : `${months} months`;
}

/** The "Got it — {summary}." echo in the one follow-up: proof we read their message,
 * in their own terms, before asking for the one thing they left out. */
export function summarizeChildren(children: readonly ExtractedChild[]): string {
  const parts = children.map(describeChild);
  if (parts.length === 0) return 'noted';
  if (parts.length === 1) return parts[0] as string;
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** The family's display name from the first named child, mirroring onboarding's
 * `${firstName}'s family`. Falls back to the neutral default when no child is named —
 * never a fabricated surname. */
export function intakeFamilyName(children: readonly ExtractedChild[]): string {
  const named = children.find((c) => c.name?.trim());
  return named?.name ? `${named.name.trim()}'s family` : 'Your family';
}
