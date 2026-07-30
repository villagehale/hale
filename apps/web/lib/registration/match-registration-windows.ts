import type { Municipality, RegistrationWindow } from '@hale/db';
import { municipalitiesForFsa } from './fsa-municipalities.js';

/**
 * The registration radar's matcher (VIL-236 · M1): given where a family lives and how
 * old its children are, which municipal registration windows are still worth warning
 * them about.
 *
 * Three deliberate conservatisms, because the failure modes are not symmetric:
 *   1. An unknown FSA yields NOTHING. Guessing a neighbouring town's dates is worse
 *      than saying nothing.
 *   2. A resident head start is claimed only when the FSA resolves to exactly one
 *      municipality. Telling a parent they can register two weeks early when they
 *      can't is the expensive mistake; the reverse just means they see the safe date.
 *   3. A child near a band edge is INCLUDED and flagged, not dropped — many Hale DOBs
 *      are derived from "she's about three", so a hard edge would silently hide the
 *      camp the family wanted.
 */

/**
 * How far outside a published age band a child may fall and still surface, flagged.
 * Six months is one half-season either side: wide enough to cover a DOB derived from
 * a parent's approximate answer, narrow enough that a 4-year-old never matches a
 * teen program.
 */
export const AGE_TOLERANCE_MONTHS = 6;

export interface RegistrationMatch {
  window: RegistrationWindow;
  /** The children (ages in months) this window's band admits, in input order. */
  matchedChildAgesMonths: number[];
  /** True when NO child is squarely in band and the match rests on the ±6-month
   * tolerance — the caller should hedge the copy ("if she's still in this band"). */
  ageApproximate: boolean;
  /** True when the family's FSA resolves to this municipality alone, so the
   * resident-priority date is theirs to use. */
  isResidentWindow: boolean;
  /** The instant THIS family can first register — the resident date when residency
   * is confirmed and the municipality publishes one, otherwise the general date. */
  opensForFamilyAt: Date;
  /** The general/non-resident open instant, always surfaced so copy can name both. */
  generalOpenAt: Date;
}

/**
 * The municipalities a postal code could belong to, via its FSA (first three
 * characters). Returns every candidate: some FSAs straddle a municipal boundary
 * (Thornhill's L4J spans Vaughan and Markham), and an empty list means "outside the
 * covered set" — never a guess. See fsa-municipalities.ts for coverage limits.
 */
export function resolveMunicipalities(postal: string): Municipality[] {
  const fsa = postal.replace(/\s+/g, '').toUpperCase().slice(0, 3);
  if (!/^[A-Z]\d[A-Z]$/.test(fsa)) return [];
  return [...municipalitiesForFsa(fsa)];
}

/** Whether a child's age sits inside the band, allowing `slack` months either side. */
function inBand(ageMonths: number, min: number | null, max: number | null, slack: number): boolean {
  if (min !== null && ageMonths < min - slack) return false;
  if (max !== null && ageMonths > max + slack) return false;
  return true;
}

export function matchRegistrationWindows(input: {
  windows: readonly RegistrationWindow[];
  postal: string;
  childrenAgesMonths: readonly number[];
  now: Date;
}): RegistrationMatch[] {
  const { windows, postal, childrenAgesMonths, now } = input;
  if (childrenAgesMonths.length === 0) return [];

  const municipalities = resolveMunicipalities(postal);
  if (municipalities.length === 0) return [];
  const covered = new Set<Municipality>(municipalities);
  // Residency is only established when the FSA points at ONE town (conservatism 2).
  const residentMunicipality = municipalities.length === 1 ? municipalities[0] : null;

  const matches: RegistrationMatch[] = [];
  for (const window of windows) {
    if (!covered.has(window.municipality)) continue;

    const matchedChildAgesMonths = childrenAgesMonths.filter((age) =>
      inBand(age, window.ageMinMonths, window.ageMaxMonths, AGE_TOLERANCE_MONTHS),
    );
    if (matchedChildAgesMonths.length === 0) continue;
    const anyExact = matchedChildAgesMonths.some((age) =>
      inBand(age, window.ageMinMonths, window.ageMaxMonths, 0),
    );

    const isResidentWindow = window.municipality === residentMunicipality;
    const opensForFamilyAt =
      isResidentWindow && window.residentOpenAt ? window.residentOpenAt : window.openAt;
    if (opensForFamilyAt.getTime() <= now.getTime()) continue;

    matches.push({
      window,
      matchedChildAgesMonths,
      ageApproximate: !anyExact,
      isResidentWindow,
      opensForFamilyAt,
      generalOpenAt: window.openAt,
    });
  }

  // Ordered by when this family must act, which is the resident date where they have
  // one — a head start they can use outranks a later general date elsewhere.
  return matches.sort(
    (a, b) =>
      a.opensForFamilyAt.getTime() - b.opensForFamilyAt.getTime() ||
      a.window.municipality.localeCompare(b.window.municipality) ||
      a.window.cycleLabel.localeCompare(b.window.cycleLabel),
  );
}
