import type { AgePrecision, ExtractedChild } from './extract';

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
}

/**
 * Canadian postal code, with the LDU (the "1A1" half) optional: `L3R` and `M5V 2T6`
 * are both complete answers to "where are you". The first letter is restricted to the
 * 18 Canada Post assigns, which is what keeps the region gate honest at FSA length —
 * `W1A` is a London outward code, and without the whitelist it is shaped exactly like
 * an FSA (rule #1: Hale is compliance-cleared for Canada only).
 */
const CANADIAN_POSTAL = /^([ABCEGHJKLMNPRSTVXY]\d[A-Za-z])(?:[ -]?(\d[A-Za-z]\d))?$/i;

/**
 * The family's location as a postal token establishes it, or null when the token is
 * not Canadian at all. Null is the REGION GATE tripping, not a formatting nit: a US
 * ZIP or a neighbourhood name reaches here as null and provisioning refuses rather
 * than guessing a country.
 */
export function parseCanadianPostal(raw: string | null): PostalContext | null {
  if (!raw) return null;
  const match = CANADIAN_POSTAL.exec(raw.trim());
  if (!match) return null;
  const areaCoarse = (match[1] as string).toUpperCase();
  const ldu = match[2]?.toUpperCase();
  return { postalCode: ldu ? `${areaCoarse} ${ldu}` : null, areaCoarse };
}

/** The country a Canadian postal code implies — matched against the onboarding region
 * gate's own alias set (lib/family/location-input), never a free-typed string. */
export const INTAKE_COUNTRY = 'Canada';

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
export function deriveDateOfBirth(
  ageMonths: number,
  precision: AgePrecision,
  now: Date,
): string {
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
  if (child.name && years !== null) return `${child.name} (${years})`;
  if (child.name) return child.name;
  if (years !== null) return years === 0 ? 'your baby' : `your ${years}-year-old`;
  return 'your little one';
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
