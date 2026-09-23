import type { Municipality, RegistrationWindow } from '@hale/db';
import { districtForFsa, municipalitiesForFsa, type TorontoDistrict } from './fsa-municipalities.js';

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
  /**
   * Every cycle this municipality opens at this same instant, on the same page, under
   * the same published age band — one registration EVENT, however many table rows the
   * source prints it as. Always contains `window` (the representative the claim and
   * the audit row key on) and is length 1 for an ordinary window.
   */
  cycleWindows: readonly RegistrationWindow[];
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

/** The Toronto registration district this postal code belongs to, or null when
 * the FSA is not one of the neighbourhood codes in fsa-municipalities.ts. */
export function resolveDistrict(postal: string): TorontoDistrict | null {
  const fsa = postal.replace(/\s+/g, '').toUpperCase().slice(0, 3);
  if (!/^[A-Z]\d[A-Z]$/.test(fsa)) return null;
  return districtForFsa(fsa);
}

/**
 * Keep the district morning when one exists for this family, and the city-wide
 * row otherwise (VIL-360).
 *
 * A cycle that has a row for `district` drops its other districts AND its
 * city-wide row — two mornings for one cycle is how a North York family was
 * handed the Etobicoke time. A cycle with no row for `district` keeps the
 * city-wide row, so a town that does not split is unchanged.
 */
export function preferDistrictRows<
  T extends {
    district?: string | null;
    municipality: string;
    programDomain: string;
    cycleLabel: string;
  },
>(rows: readonly T[], district: string): T[] {
  const scoped = new Set(
    rows
      .filter((row) => row.district === district)
      .map((row) => `${row.municipality}|${row.programDomain}|${row.cycleLabel}`),
  );
  return rows.filter((row) => {
    if (row.district === district) return true;
    if (row.district != null) return false;
    return !scoped.has(`${row.municipality}|${row.programDomain}|${row.cycleLabel}`);
  });
}

/** District-scoped rows are not for a family whose FSA did not resolve to one. */
function windowsForPostal(
  windows: readonly RegistrationWindow[],
  postal: string,
): RegistrationWindow[] {
  const district = resolveDistrict(postal);
  if (district === null) return windows.filter((window) => window.district == null);
  return preferDistrictRows(windows, district);
}

/**
 * When THIS family can first register for `window`, given where they live.
 *
 * Conservatism 2, in the one place it is decided: a resident head start is claimed only
 * when the FSA resolves to exactly ONE municipality. Extracted from the matcher because
 * the M7 sequence (VIL-242) has to answer the same question days later, for a family
 * whose whole reminder ladder is anchored on the answer — and two copies of this rule
 * would eventually disagree about which date a household is owed.
 */
export function resolveFamilyOpen(
  window: RegistrationWindow,
  /** The family's postal code or FSA. Null (a family with no area on file) resolves to
   * nothing, which is the safe answer: they get the general date, never a head start
   * they cannot use. */
  postal: string | null,
): { isResidentWindow: boolean; opensForFamilyAt: Date } {
  const municipalities = postal === null ? [] : resolveMunicipalities(postal);
  const isResidentWindow =
    municipalities.length === 1 && municipalities[0] === window.municipality;
  return {
    isResidentWindow,
    opensForFamilyAt:
      isResidentWindow && window.residentOpenAt ? window.residentOpenAt : window.openAt,
  };
}

/** A cycle this family's town has ALREADY opened — the evidence that the town is
 * between cycles rather than off the radar. */
export interface PastRegistrationCycle {
  window: RegistrationWindow;
  /** The instant THIS family could first have registered, so a resident head start is
   * the date that already went. */
  openedForFamilyAt: Date;
  /** Every cycle label the fetched rows carry for this town and domain — past, upcoming,
   * or ruled out by a child's age band alike. A posted cycle is not one Hale is still
   * waiting on, whoever it turned out to be for, so this is what decides whether there is
   * a next cycle left to name (lib/registration/discovery-targets nextWatchedCycle). */
  knownCycleLabels: ReadonlySet<string>;
}

/**
 * The most recent cycle the family's municipalities have already opened, or null.
 *
 * The matcher above answers "what can this family still act on"; this answers the
 * question its empty result cannot — whether the silence means a town Hale has never
 * had dates for, or a town whose season has simply gone and whose next dates are not
 * posted yet. Two different sentences, and a parent can tell them apart.
 *
 * Deliberately NOT age-banded, unlike a match: the claim is about the TOWN's calendar
 * ("Halton Hills' Fall registration already opened"), not about a program for this
 * child, so narrowing it by band would silence a family whose town plainly did open.
 */
export function latestPastCycle(input: {
  windows: readonly RegistrationWindow[];
  postal: string;
  now: Date;
}): PastRegistrationCycle | null {
  const covered = new Set<Municipality>(resolveMunicipalities(input.postal));
  if (covered.size === 0) return null;

  const applicable = windowsForPostal(input.windows, input.postal);
  const past: Omit<PastRegistrationCycle, 'knownCycleLabels'>[] = [];
  for (const window of applicable) {
    if (!covered.has(window.municipality)) continue;
    const { opensForFamilyAt } = resolveFamilyOpen(window, input.postal);
    if (opensForFamilyAt.getTime() > input.now.getTime()) continue;
    past.push({ window, openedForFamilyAt: opensForFamilyAt });
  }

  // Most recent first, with the same municipality/cycle tie-breaks the matcher sorts
  // by, so two rows that opened on the same morning never pick a different winner run
  // to run.
  past.sort(
    (a, b) =>
      b.openedForFamilyAt.getTime() - a.openedForFamilyAt.getTime() ||
      a.window.municipality.localeCompare(b.window.municipality) ||
      a.window.cycleLabel.localeCompare(b.window.cycleLabel),
  );
  const latest = past[0];
  if (!latest) return null;

  return { ...latest, knownCycleLabels: knownCycleLabelsFor(input.windows, latest.window) };
}

/**
 * Every label the DATASET holds for this town and domain, not just the past ones: a
 * cycle with a row is published, and publishing it is exactly what ends the wait.
 *
 * Taken over the WHOLE fetched set, never a filtered one — which is why it is a
 * function rather than a line inside the scan above. {@link stillOpenCycle} narrows by
 * age band before it scans, and a published cycle is published whether or not this
 * child fits it: computed over the narrowed set, a season already on the page would
 * come back as one the sweep is still waiting for.
 */
function knownCycleLabelsFor(
  windows: readonly RegistrationWindow[],
  of: RegistrationWindow,
): ReadonlySet<string> {
  return new Set(
    windows
      .filter(
        (window) =>
          window.municipality === of.municipality && window.programDomain === of.programDomain,
      )
      .map((window) => window.cycleLabel),
  );
}

/**
 * How long after a municipal open the page is still where a parent should be sent.
 *
 * Three weeks: the same horizon the civic projection already calls this week's news
 * (FORWARD_WINDOW_DAYS, lib/civic/project.ts), and past it the popular classes are gone
 * and the between-cycles sentence is the honest one. The dataset has NO close date —
 * `open_at` is the only required instant (registration-windows.ts) — so this bound is
 * the whole of what stops "opened in March" from reading as news in September.
 */
export const OPEN_NOW_MAX_AGE_DAYS = 21;

/**
 * The most recent cycle these municipalities opened that a child of THIS family could
 * still act on: inside `maxAgeDays`, and admitting at least one child under the
 * matcher's own ±6 tolerance ({@link AGE_TOLERANCE_MONTHS}). Null when none does.
 *
 * Banded where {@link latestPastCycle} is not, and for the reason that one gives for
 * not being: it answers "did this town open anything", which is a claim about a
 * CALENDAR; this answers "can I sign my kid up right now", which is a claim about a
 * PROGRAM FOR THIS CHILD. A two-year-old's family whose town most recently opened
 * after-school care would otherwise be told nothing, while the town's rec-program
 * cycle — open, in band, a few days older — sat unnamed.
 *
 * It scans EVERY past open inside the bound rather than band-filtering one winner, and
 * it is not a second rung: the caller uses whichever row it returns to build the ONE
 * registration absence, so a town never gets two cycles in a stranger's first text.
 */
export function stillOpenCycle(input: {
  windows: readonly RegistrationWindow[];
  postal: string;
  childrenAgesMonths: readonly number[];
  now: Date;
  maxAgeDays: number;
}): PastRegistrationCycle | null {
  if (input.childrenAgesMonths.length === 0) return null;
  const earliest = input.now.getTime() - input.maxAgeDays * 24 * 60 * 60 * 1000;
  const applicable = windowsForPostal(input.windows, input.postal);
  const inBound = applicable.filter((window) => {
    if (
      !input.childrenAgesMonths.some((age) =>
        inBand(age, window.ageMinMonths, window.ageMaxMonths, AGE_TOLERANCE_MONTHS),
      )
    ) {
      return false;
    }
    const { opensForFamilyAt } = resolveFamilyOpen(window, input.postal);
    return opensForFamilyAt.getTime() >= earliest;
  });
  // Delegated rather than re-sorted: the most-recent-first order and its
  // municipality/cycle tie-breaks live in ONE place, so the two scans can never pick a
  // different winner out of the same rows for a reason nobody wrote down.
  const winner = latestPastCycle({ windows: inBound, postal: input.postal, now: input.now });
  if (winner === null) return null;
  return { ...winner, knownCycleLabels: knownCycleLabelsFor(input.windows, winner.window) };
}

/** Whether a child's age sits inside the band, allowing `slack` months either side.
 * Exported so a caller can name the children a band admits without a second copy of
 * the rule (sequence/shortlist.ts is already the second copy). */
export function inBand(
  ageMonths: number,
  min: number | null,
  max: number | null,
  slack: number,
): boolean {
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
  const { postal, childrenAgesMonths, now } = input;
  if (childrenAgesMonths.length === 0) return [];

  const municipalities = resolveMunicipalities(postal);
  if (municipalities.length === 0) return [];
  const covered = new Set<Municipality>(municipalities);
  const windows = windowsForPostal(input.windows, postal);

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

    const { isResidentWindow, opensForFamilyAt } = resolveFamilyOpen(window, postal);
    if (opensForFamilyAt.getTime() <= now.getTime()) continue;

    matches.push({
      window,
      cycleWindows: [window],
      matchedChildAgesMonths,
      ageApproximate: !anyExact,
      isResidentWindow,
      opensForFamilyAt,
      generalOpenAt: window.openAt,
    });
  }

  // Ordered by when this family must act, which is the resident date where they have
  // one — a head start they can use outranks a later general date elsewhere.
  matches.sort(
    (a, b) =>
      a.opensForFamilyAt.getTime() - b.opensForFamilyAt.getTime() ||
      a.window.municipality.localeCompare(b.window.municipality) ||
      a.window.cycleLabel.localeCompare(b.window.cycleLabel),
  );
  return collapseCoOpeningCycles(matches);
}

/**
 * One municipality often publishes several cycles that open at the SAME instant on the
 * SAME page — Burlington's fall/winter youth, fall swim and fall/winter Aquatic
 * Leadership rows are one registration morning printed as three table rows. Kept
 * separate, the sort's alphabetical tie-break silently decided which of them a family
 * was told about, and "Aquatic Leadership" sorts first: a household with a
 * 30-month-old was proposed the teen lifeguard-certification cycle.
 *
 * They collapse into one match. The AGE BAND is part of the key, deliberately: two
 * cycles that open together under different published bands produce different per-child
 * fit notes, so merging them would attach one cycle's band to another's children.
 */
function collapseCoOpeningCycles(sorted: readonly RegistrationMatch[]): RegistrationMatch[] {
  const byEvent = new Map<string, { match: RegistrationMatch; windows: RegistrationWindow[] }>();
  for (const match of sorted) {
    const { window } = match;
    const key = [
      window.municipality,
      match.opensForFamilyAt.getTime(),
      window.sourceUrl,
      window.ageMinMonths,
      window.ageMaxMonths,
    ].join('|');
    const group = byEvent.get(key);
    if (group) group.windows.push(window);
    else byEvent.set(key, { match, windows: [window] });
  }
  return [...byEvent.values()].map(({ match, windows }) => ({ ...match, cycleWindows: windows }));
}
