import { formatWhenPhrase } from '~/lib/format/datetime';
import { priceBandLabel } from '~/lib/format/labels';
import type { RegistrationMatch } from '~/lib/registration/match-registration-windows';
import { AGE_TOLERANCE_MONTHS } from '~/lib/registration/match-registration-windows';
import { type Season, seasonOf } from '~/lib/village/visibility';
import { type DailyOutlook, isOutdoorFriendly } from '~/lib/weather/open-meteo';

/**
 * VIL-238 · M3 — DECIDE: what Hale has actually spotted for this family, as a
 * structured object. No model runs in this file, deliberately.
 *
 * The split matters. A ranking a model invents is a ranking nobody can test, and the
 * first message a stranger gets from Hale is exactly where a plausible-sounding
 * fabrication would do the most damage — it would be indistinguishable from the real
 * thing. So every judgement that can be made deterministically is made HERE, in pure
 * code with a unit test behind it, and the model downstream (COMPOSE) only writes the
 * words around the facts this file emits.
 *
 * The cascade, in order:
 *
 *   1. FILTER — hard, cheap, deterministic: teen attribution (rule #1), age fit, the
 *      coming weekend, season, weather.
 *   2. RANK — free-first as a HARD ordering rule; a pick covering both kids beats two
 *      that each cover one; a paid pick may only win when it is CLEARLY better, and
 *      then only because it carries a price label.
 *   3. EMIT — a decision object whose every string is a fact, with the honest absences
 *      (no pick, no window) represented as nulls rather than papered over.
 *
 * Multi-kid discipline: ONE message per family, ONE pick inside it. A three-kid family
 * does not get three age-band paragraphs — Hale tracks all of them and speaks about the
 * one that matters most. A day that would split the siblings between two activities is
 * not suggested at all.
 */

export type WeekendDay = 'saturday' | 'sunday';

/** How much better a PAID pick must score before it may outrank a free one. Two points
 * is exactly the both-kids bonus: a paid option wins only by fitting the whole family
 * where the free one fits half of it — never by being marginally nicer. */
export const CLEARLY_BETTER_MARGIN = 2;

/** How many facts ride with a pick. The payload is billed per SMS segment and read on a
 * phone; a fourth clause is cost without comprehension. */
const MAX_WHY_FACTS = 3;

export interface RadarChild {
  /** The name the parent gave, or null when they described a child without naming one. */
  name: string | null;
  ageMonths: number | null;
  /** 'derived' — the parent gave an age, not a date — widens every age fit by ±6 months
   * (the same tolerance the registration matcher applies, and for the same reason). */
  dobPrecision: 'exact' | 'derived';
}

/** The village_candidates fields a decision can rest on. Titles and venues are PUBLIC
 * places; nothing here is a family's own location. */
export interface RadarCandidate {
  id: string;
  title: string;
  venueName: string | null;
  ageRange: string | null;
  priceLevel: string | null;
  indoorOutdoor: string | null;
  eventDate: string | null;
  seasons: string[] | null;
  childId: string | null;
  confidence: number;
}

export interface WeekendPick {
  /** What this pick IS. The id is for us; the title/venue are the only renderable parts. */
  candidateRef: { id: string; title: string; venueName: string | null };
  day: WeekendDay;
  /** The kids it fits, by the names the parent gave. Empty when they named nobody. */
  kidNames: string[];
  /** EVERY fact the composer may state about this pick. If it is not here, it is not
   * true — the composer has nothing else to work from. */
  whyFacts: string[];
}

export interface RegistrationLine {
  windowRef: { municipality: string; programDomain: string; cycleLabel: string };
  /** When THIS family can first register, in their own zone. */
  opensAtLocal: string;
  kidNames: string[];
  /** Set only when the family's FSA resolves to one town that publishes a head start. */
  residentNote: string | null;
  /** True when the match rests on the ±6-month tolerance — the copy should hedge. */
  ageApproximate: boolean;
}

export interface RadarDecision {
  weekendPick: WeekendPick | null;
  registrationLine: RegistrationLine | null;
  /** Always true: the state machine appends the watch offer itself, so the composer
   * must not write a question of its own (that would ask twice). */
  offerQuestion: true;
  /** Hale could not name a pick yet — discovery may still be running. The caller may
   * act on this later; nothing in this stage sends anything. */
  followUpNeeded: boolean;
}

export interface DecideRadarInput {
  children: readonly RadarChild[];
  candidates: readonly RadarCandidate[];
  /** Already matched by the M1 matcher, soonest-first. */
  windows: readonly RegistrationMatch[];
  /** Empty when the outlook is unavailable — then no weather claim is made at all. */
  weather: readonly DailyOutlook[];
  /** Candidates attributed to these children never leave the building (rule #1). */
  teenChildIds: readonly string[];
  now: Date;
  timeZone: string;
}

// ── calendar ─────────────────────────────────────────────────────────────────

function dateKey(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone,
  }).format(date);
}

/** Day arithmetic on the KEY, not the instant: adding 24h across a DST boundary can
 * land on the same local day, adding a day to `YYYY-MM-DD` never does. */
function addDays(key: string, days: number): string {
  return new Date(Date.parse(`${key}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

function weekdayOf(key: string): number {
  return new Date(`${key}T00:00:00Z`).getUTCDay();
}

/**
 * The weekend this family is walking into, in THEIR zone: Saturday and Sunday from any
 * weekday, both from Saturday itself, and — on Sunday, when Saturday has already gone —
 * Sunday alone. Never next week's: a pick a parent can act on tomorrow is the point.
 */
export function upcomingWeekend(
  now: Date,
  timeZone: string,
): Array<{ day: WeekendDay; date: string }> {
  const today = dateKey(now, timeZone);
  const dow = weekdayOf(today);
  if (dow === 0) return [{ day: 'sunday', date: today }];
  const saturday = addDays(today, (6 - dow + 7) % 7);
  return [
    { day: 'saturday', date: saturday },
    { day: 'sunday', date: addDays(saturday, 1) },
  ];
}

// ── age bands ────────────────────────────────────────────────────────────────

const MONTHS_PER_YEAR = 12;
const ALL_AGES = /\b(all[\s-]?ages|any age|every ?age)\b/i;
const MONTH_UNIT = /\b(months?|mos?)\b/i;
const RANGE = /(\d+(?:\.\d+)?)\s*(?:[-–—]|to)\s*(\d+(?:\.\d+)?)/;
const OPEN_MIN = /(\d+(?:\.\d+)?)\s*(?:months?|mos?|years?|yrs?)?\s*(?:\+|and up|and older|or older|and over)/i;
const OPEN_MAX = /(?:under|up to|below|younger than)\s*(\d+(?:\.\d+)?)/i;

export interface AgeBand {
  minMonths: number | null;
  maxMonths: number | null;
}

function toMonths(value: number, inMonths: boolean): number {
  return Math.round(inMonths ? value : value * MONTHS_PER_YEAR);
}

/**
 * Read a discovery-emitted age label ("3–5 years", "6-18 months", "all ages") into a
 * band. Returns null for a label we cannot read — UNKNOWN, which is not the same as
 * unbounded: an unknown band never disqualifies a candidate (we have no fact to
 * disqualify it with) but it never lets Hale CLAIM an age fit either.
 */
export function parseAgeRange(text: string | null): AgeBand | null {
  const label = text?.trim();
  if (!label) return null;
  if (ALL_AGES.test(label)) return { minMonths: null, maxMonths: null };

  const inMonths = MONTH_UNIT.test(label);

  const range = RANGE.exec(label);
  if (range) {
    return {
      minMonths: toMonths(Number(range[1]), inMonths),
      maxMonths: toMonths(Number(range[2]), inMonths),
    };
  }

  const openMin = OPEN_MIN.exec(label);
  if (openMin) return { minMonths: toMonths(Number(openMin[1]), inMonths), maxMonths: null };

  const openMax = OPEN_MAX.exec(label);
  if (openMax) return { minMonths: null, maxMonths: toMonths(Number(openMax[1]), inMonths) };

  return null;
}

/** Whether a child's age sits in the band, with the slack a derived DOB earns. */
function fitsBand(child: RadarChild, band: AgeBand, slack: number): boolean {
  if (child.ageMonths === null) return false;
  if (band.minMonths !== null && child.ageMonths < band.minMonths - slack) return false;
  if (band.maxMonths !== null && child.ageMonths > band.maxMonths + slack) return false;
  return true;
}

function slackFor(child: RadarChild): number {
  return child.dobPrecision === 'derived' ? AGE_TOLERANCE_MONTHS : 0;
}

// ── the cascade ──────────────────────────────────────────────────────────────

interface Placed {
  candidate: RadarCandidate;
  band: AgeBand | null;
  /** Indexes into `children` this pick fits. */
  coverage: number[];
  /** True when every covered child is squarely in band, no tolerance needed. */
  exactFit: boolean;
  day: WeekendDay;
  date: string;
  /** The forecast for the placed day, when there is one. */
  outlook: DailyOutlook | null;
  score: number;
  priceRank: number;
}

function priceRankOf(priceLevel: string | null): number {
  if (priceLevel === 'free') return 0;
  // An unlabelled price is UNKNOWN, not free — it may never be described as free, and
  // it sits behind a genuinely free option.
  if (priceLevel === null) return 1;
  return 2;
}

/** Who a candidate is for. An unreadable age label covers everyone (we have no fact
 * that excludes anybody), but `band === null` is remembered so no age claim is made. */
export function coverageOf(children: readonly RadarChild[], band: AgeBand | null): number[] {
  if (band === null) return children.map((_, index) => index);
  return children
    .map((child, index) => (fitsBand(child, band, slackFor(child)) ? index : -1))
    .filter((index) => index >= 0);
}

function isOutdoor(candidate: RadarCandidate): boolean {
  return candidate.indoorOutdoor === 'outdoor';
}

function inSeason(candidate: RadarCandidate, season: Season): boolean {
  if (!candidate.seasons || candidate.seasons.length === 0) return true;
  return candidate.seasons.includes(season);
}

/**
 * Every way this candidate could land on the coming weekend. A DATED candidate can only
 * be its own date (and only if that date is this weekend — a Wednesday event is not a
 * weekend pick); an undated one can be either day. An OUTDOOR candidate is placeable
 * only on a day the forecast does not rule out; with no forecast at all, no day is
 * ruled out and no weather claim will be made.
 */
function placements(
  candidate: RadarCandidate,
  weekend: ReadonlyArray<{ day: WeekendDay; date: string }>,
  weather: readonly DailyOutlook[],
): Array<{ day: WeekendDay; date: string; outlook: DailyOutlook | null }> {
  const days = candidate.eventDate
    ? weekend.filter((slot) => slot.date === candidate.eventDate)
    : weekend;
  return days
    .map((slot) => ({
      ...slot,
      outlook: weather.find((entry) => entry.date === slot.date) ?? null,
    }))
    .filter((slot) => {
      if (!isOutdoor(candidate)) return true;
      return slot.outlook === null || isOutdoorFriendly(slot.outlook);
    });
}

function scoreOf(coverage: number[], exactFit: boolean, candidate: RadarCandidate): number {
  let score = 0;
  // The multi-kid rule, made numeric: one pick for both kids beats two singles.
  if (coverage.length >= 2) score += CLEARLY_BETTER_MARGIN;
  if (exactFit) score += 1;
  // A dated event is a real thing happening at a real time — it beats an evergreen
  // option a parent could take up any weekend.
  if (candidate.eventDate) score += 1;
  return score + candidate.confidence;
}

/** Best of a list by score, then title, so the choice is stable run to run. */
function bestOf(placed: readonly Placed[]): Placed | null {
  return (
    [...placed].sort(
      (a, b) => b.score - a.score || a.candidate.title.localeCompare(b.candidate.title),
    )[0] ?? null
  );
}

/**
 * The days that would split the family: a day carrying two DATED options for DISJOINT
 * sets of siblings, neither of which covers everybody. Suggesting either means
 * suggesting that one child's Saturday wins — so Hale suggests neither and looks at the
 * other day.
 *
 * Only DATED options count. An evergreen drop-in is not a time conflict — a parent
 * chooses when to go — and treating two ongoing options as one would silence a
 * three-kid family's radar entirely (each ongoing option covering a different band).
 */
function splittingDays(placed: readonly Placed[], childCount: number): Set<string> {
  const dated = placed.filter((entry) => entry.candidate.eventDate !== null);
  const split = new Set<string>();
  for (const a of dated) {
    for (const b of dated) {
      if (a === b || a.date !== b.date) continue;
      if (a.coverage.length === 0 || b.coverage.length === 0) continue;
      if (a.coverage.length === childCount || b.coverage.length === childCount) continue;
      if (a.coverage.some((index) => b.coverage.includes(index))) continue;
      split.add(a.date);
    }
  }
  return split;
}

function whyFactsFor(placed: Placed): string[] {
  const facts: string[] = [];
  const price = priceBandLabel(placed.candidate.priceLevel);
  if (placed.candidate.priceLevel === 'free') facts.push('free');
  else if (price) facts.push(`paid (${price})`);

  if (placed.candidate.indoorOutdoor === 'indoor' || placed.candidate.indoorOutdoor === 'outdoor') {
    facts.push(placed.candidate.indoorOutdoor);
  }
  // A weather claim is made ONLY when there is a forecast for that day saying so.
  if (isOutdoor(placed.candidate) && placed.outlook && isOutdoorFriendly(placed.outlook)) {
    facts.push('the forecast looks dry');
  }
  if (placed.band !== null && placed.candidate.ageRange) {
    facts.push(`for ${placed.candidate.ageRange.trim()}`);
  }
  return facts.slice(0, MAX_WHY_FACTS);
}

function namesOf(children: readonly RadarChild[], indexes: readonly number[]): string[] {
  return indexes
    .map((index) => children[index]?.name)
    .filter((name): name is string => typeof name === 'string' && name.trim().length > 0);
}

/** Intl can emit a narrow no-break space around "a.m." depending on the ICU build, and
 * one non-ASCII character doubles the cost of the whole SMS (see sms-segments.ts). */
export function asciiSpaces(text: string): string {
  return text.replace(/[   ]/g, ' ');
}

function decideRegistration(input: DecideRadarInput): RegistrationLine | null {
  // The matcher already ordered by when THIS family must act; the soonest is the one
  // worth a stranger's first text.
  const match = input.windows[0];
  if (!match) return null;

  const matchedAges = new Set(match.matchedChildAgesMonths);
  const kidNames = input.children
    .filter((child) => child.ageMonths !== null && matchedAges.has(child.ageMonths))
    .map((child) => child.name)
    .filter((name): name is string => typeof name === 'string' && name.trim().length > 0);

  return {
    windowRef: {
      municipality: match.window.municipality,
      programDomain: match.window.programDomain,
      cycleLabel: match.window.cycleLabel,
    },
    opensAtLocal: asciiSpaces(
      formatWhenPhrase(match.opensForFamilyAt, input.timeZone, input.now),
    ),
    kidNames,
    residentNote:
      match.isResidentWindow && match.window.residentOpenAt !== null
        ? 'residents can register first'
        : null,
    ageApproximate: match.ageApproximate,
  };
}

function decideWeekendPick(input: DecideRadarInput): WeekendPick | null {
  const weekend = upcomingWeekend(input.now, input.timeZone);
  const season = seasonOf(input.now, input.timeZone);
  const teen = new Set(input.teenChildIds);

  const placed: Placed[] = [];
  for (const candidate of input.candidates) {
    // Rule #1: a 13+ child's activity is never named to a parent over SMS. Discovery
    // already excludes teens at the source; this is the surface-side backstop.
    if (candidate.childId !== null && teen.has(candidate.childId)) continue;
    if (!inSeason(candidate, season)) continue;

    const band = parseAgeRange(candidate.ageRange);
    const coverage = coverageOf(input.children, band);
    if (input.children.length > 0 && coverage.length === 0) continue;
    const exactFit =
      band !== null && coverage.every((index) => fitsBand(input.children[index] as RadarChild, band, 0));

    for (const slot of placements(candidate, weekend, input.weather)) {
      placed.push({
        candidate,
        band,
        coverage,
        exactFit,
        day: slot.day,
        date: slot.date,
        outlook: slot.outlook,
        score: scoreOf(coverage, exactFit, candidate),
        priceRank: priceRankOf(candidate.priceLevel),
      });
    }
  }

  const split = splittingDays(placed, input.children.length);
  const eligible = placed.filter(
    (entry) => !split.has(entry.date) || entry.coverage.length === input.children.length,
  );
  if (eligible.length === 0) return null;

  // Free-first is a HARD ordering rule: work up the price ranks and take the first rank
  // that has anything in it…
  let chosen: Placed | null = null;
  for (const rank of [0, 1, 2]) {
    chosen = bestOf(eligible.filter((entry) => entry.priceRank === rank));
    if (chosen) break;
  }
  if (!chosen) return null;

  // …then let a PAID option overturn that only when it is clearly the better fit. It
  // can only ever be surfaced with its price label attached (whyFactsFor).
  if (chosen.priceRank < 2) {
    const paid = bestOf(eligible.filter((entry) => entry.priceRank === 2));
    if (paid && paid.score >= chosen.score + CLEARLY_BETTER_MARGIN) chosen = paid;
  }

  return {
    candidateRef: {
      id: chosen.candidate.id,
      title: chosen.candidate.title,
      venueName: chosen.candidate.venueName,
    },
    day: chosen.day,
    kidNames: namesOf(input.children, chosen.coverage),
    whyFacts: whyFactsFor(chosen),
  };
}

export function decideRadar(input: DecideRadarInput): RadarDecision {
  const weekendPick = decideWeekendPick(input);
  return {
    weekendPick,
    registrationLine: decideRegistration(input),
    offerQuestion: true,
    // Nothing to point at this weekend: discovery may still be running, so Hale owes
    // this family a pick later. Flag only — this stage sends nothing.
    followUpNeeded: weekendPick === null,
  };
}
