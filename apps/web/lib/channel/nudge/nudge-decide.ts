import {
  type AgeBand,
  type RadarCandidate,
  type RadarChild,
  type WeekendDay,
  asciiSpaces,
  coverageOf,
  parseAgeRange,
  upcomingWeekend,
} from '~/lib/channel/intake/radar-decide';
import { formatWhenPhrase } from '~/lib/format/datetime';
import { priceBandLabel } from '~/lib/format/labels';
import type { HealthRegion } from '~/lib/health/checkpoints';
import { type HealthChild, matchHealthCheckpoints } from '~/lib/health/match';
import type { RegistrationMatch } from '~/lib/registration/match-registration-windows';
import { type Season, seasonOf } from '~/lib/village/visibility';
import { type DailyOutlook, isOutdoorFriendly, outdoorBlocker } from '~/lib/weather/open-meteo';

/**
 * VIL-239 · M4 — DECIDE: the ONE thing worth texting this family unprompted, or
 * NOTHING. No model runs in this file, deliberately — the same split M3 uses, for the
 * same reason, only with higher stakes: this message is not an answer to anything the
 * parent said, so a plausible-sounding fabrication arrives with no context to correct
 * it and no question it was replying to.
 *
 * Three things can earn an unprompted text, in strict priority order:
 *
 *   1. A REGISTRATION WINDOW inside {@link REGISTRATION_HORIZON_DAYS}. It wins
 *      unconditionally because it is the only thing here with a HARD deadline — a swim
 *      class that fills in nine minutes is the difference between Hale being useful
 *      and Hale being a newsletter.
 *   2. A HEALTH-ADMIN CHECKPOINT (VIL-243 · M8): an Ontario paperwork window this
 *      family is inside. Below registration because a cadence tolerates a week's wait
 *      and a nine-minute swim class does not — but above the weekend, because a
 *      registration deadline and a school records check are both things a parent
 *      cannot reconstruct later, and a weekend suggestion is an offer they can.
 *   3. A WEATHER-FIT WEEKEND SWAP: the forecast rules the weekend out and there is a
 *      real indoor option, or a day is genuinely good and there is a real FREE outdoor
 *      one. Both halves must be true. A forecast with no candidate is a weather app;
 *      a candidate with no forecast is a guess.
 *
 * Otherwise: null. Silence is a first-class outcome and the most common correct one —
 * the caller records that this family was evaluated and had nothing worth a text,
 * which is the metric that tells us whether the nudge is a signal or a habit.
 *
 * Multi-kid discipline, inherited from M3: ONE message per family, ONE thing inside
 * it, every kid it applies to named in line. Never one message per child.
 */

/** How far ahead a registration date is still news. A week is long enough to plan
 * around and short enough that the text arrives while it still matters; a date three
 * weeks out texted today is just noise that will need repeating anyway. */
export const REGISTRATION_HORIZON_DAYS = 7;

/** How many facts ride with a pick. Billed per segment, read on a phone. */
const MAX_WHY_FACTS = 2;

/** The weather claim each blocker earns. Fixed strings, because the composer may only
 * restate a fact this file emitted, and "wet" must never be rendered as "cold". */
const WEATHER_FACT: Record<'wet' | 'cold' | 'hot', string> = {
  wet: 'the weekend forecast is wet',
  cold: 'the weekend forecast is cold',
  hot: 'the weekend forecast is hot',
};

/** Said only about a day the forecast actually clears. Matches M3's phrasing so the
 * two surfaces do not describe the same fact two different ways. */
const DRY_FACT = 'the forecast looks dry';

export interface RegistrationNudge {
  kind: 'registration';
  /** The id is for us (it is the dedupe key's natural identity); the town, cycle and
   * open time are the only renderable parts. */
  windowRef: { id: string; municipality: string; programDomain: string; cycleLabel: string };
  /** When THIS family can first register, in their own zone. */
  opensAtLocal: string;
  kidNames: string[];
  /** Set only when the family's FSA resolves to one town that publishes a head start. */
  residentNote: string | null;
  /** True when the match rests on the ±6-month tolerance — the copy should hedge. */
  ageApproximate: boolean;
}

export interface WeatherSwapNudge {
  kind: 'weather_swap';
  /** The id is for us; the title/venue are the only renderable parts. */
  candidateRef: { id: string; title: string; venueName: string | null };
  day: WeekendDay;
  kidNames: string[];
  /** The ONE forecast fact this swap rests on. Never absent — a swap with no weather
   * fact is not a weather swap. */
  weatherFact: string;
  whyFacts: string[];
}

/**
 * VIL-243 · M8. Carries the checkpoint by REFERENCE, not by copy: the renderable
 * strings live in the reviewed content table (lib/health/checkpoints.ts) and are looked
 * up at render time, so a copy correction lands everywhere at once and no decision
 * object can ever hold a stale sentence.
 */
export interface HealthCheckpointNudge {
  kind: 'health_checkpoint';
  checkpointRef: { id: string; region: HealthRegion };
  /** This checkpoint's identity for this family: what the sweep dedupes on and what a
   * "done" reply suppresses. Built by the matcher, never rebuilt. Never rendered. */
  ref: string;
  /** Under-13 children only. A 13+ child is NEVER named over this channel (rule #1). */
  kidNames: string[];
  /** True when every matched child is 13+, and the copy must go generic. */
  teenOnly: boolean;
  teenCount: number;
}

export type Nudge = RegistrationNudge | HealthCheckpointNudge | WeatherSwapNudge;

export interface DecideNudgeInput {
  children: readonly RadarChild[];
  candidates: readonly RadarCandidate[];
  /** Already matched by the M1 matcher, soonest-first. */
  windows: readonly RegistrationMatch[];
  /** Empty when the outlook is unavailable — then no swap is possible at all. */
  weather: readonly DailyOutlook[];
  /** Candidates attributed to these children never leave the building (rule #1). */
  teenChildIds: readonly string[];
  /**
   * EVERY child, 13+ included, with the ids the health checkpoints key on. A separate
   * list from `children` on purpose: `children` is the under-13 roster a weekend
   * suggestion may be built around, while a school records check is the parent's legal
   * obligation for a teenager too — it is only the WORDING that changes.
   */
  healthChildren: readonly HealthChild[];
  /** The family's FSA. Health checkpoints are region-gated; null means none apply. */
  areaCoarse: string | null;
  /** Checkpoint refs the family has already told us are handled. */
  doneCheckpointRefs: ReadonlySet<string>;
  now: Date;
  timeZone: string;
}

function namesOf(children: readonly RadarChild[], indexes: readonly number[]): string[] {
  return indexes
    .map((index) => children[index]?.name)
    .filter((name): name is string => typeof name === 'string' && name.trim().length > 0);
}

// ── priority 1: a registration window ────────────────────────────────────────

function decideRegistration(input: DecideNudgeInput): RegistrationNudge | null {
  // The matcher already dropped windows that have opened and ordered the rest by when
  // THIS family must act, so the soonest is the only one worth considering.
  const match = input.windows[0];
  if (!match) return null;

  const horizon = input.now.getTime() + REGISTRATION_HORIZON_DAYS * 86_400_000;
  if (match.opensForFamilyAt.getTime() > horizon) return null;

  const matchedAges = new Set(match.matchedChildAgesMonths);
  const kidNames = input.children
    .filter((child) => child.ageMonths !== null && matchedAges.has(child.ageMonths))
    .map((child) => child.name)
    .filter((name): name is string => typeof name === 'string' && name.trim().length > 0);

  return {
    kind: 'registration',
    windowRef: {
      id: match.window.id,
      municipality: match.window.municipality,
      programDomain: match.window.programDomain,
      cycleLabel: match.window.cycleLabel,
    },
    opensAtLocal: asciiSpaces(formatWhenPhrase(match.opensForFamilyAt, input.timeZone, input.now)),
    kidNames,
    residentNote:
      match.isResidentWindow && match.window.residentOpenAt !== null
        ? 'residents can register first'
        : null,
    ageApproximate: match.ageApproximate,
  };
}

// ── priority 2: a health-admin checkpoint ────────────────────────────────────

/**
 * The ONE administrative window worth a text, or nothing. The matcher already ordered
 * by which window closes first and already dropped anything the family marked done, so
 * the head of its list is the whole decision.
 */
function decideHealthCheckpoint(input: DecideNudgeInput): HealthCheckpointNudge | null {
  const [match] = matchHealthCheckpoints({
    children: input.healthChildren,
    areaCoarse: input.areaCoarse,
    doneRefs: input.doneCheckpointRefs,
    now: input.now,
  });
  if (!match) return null;

  return {
    kind: 'health_checkpoint',
    checkpointRef: { id: match.checkpoint.id, region: match.checkpoint.region },
    ref: match.ref,
    kidNames: match.kidNames,
    teenOnly: match.teenOnly,
    teenCount: match.teenCount,
  };
}

// ── priority 3: a weather-fit weekend swap ───────────────────────────────────

interface Fitted {
  candidate: RadarCandidate;
  band: AgeBand | null;
  coverage: number[];
}

function inSeason(candidate: RadarCandidate, season: Season): boolean {
  if (!candidate.seasons || candidate.seasons.length === 0) return true;
  return candidate.seasons.includes(season);
}

/**
 * The candidates that could honestly be suggested for `date`: not a teen's, in season,
 * age-appropriate, and — when the candidate is dated — actually happening that day.
 * Ranked by how much of the family they cover, then by confidence, then by title so a
 * tie is stable run to run.
 */
function fittedFor(
  input: DecideNudgeInput,
  date: string,
  admits: (candidate: RadarCandidate) => boolean,
): Fitted | null {
  const season = seasonOf(input.now, input.timeZone);
  const teen = new Set(input.teenChildIds);

  const fitted: Fitted[] = [];
  for (const candidate of input.candidates) {
    // Rule #1: a 13+ child's activity is never named to a parent over SMS. Discovery
    // excludes teens at the source; this is the surface-side backstop.
    if (candidate.childId !== null && teen.has(candidate.childId)) continue;
    if (!admits(candidate)) continue;
    if (!inSeason(candidate, season)) continue;
    if (candidate.eventDate !== null && candidate.eventDate !== date) continue;

    const band = parseAgeRange(candidate.ageRange);
    const coverage = coverageOf(input.children, band);
    if (input.children.length > 0 && coverage.length === 0) continue;
    fitted.push({ candidate, band, coverage });
  }

  return (
    fitted.sort(
      (a, b) =>
        b.coverage.length - a.coverage.length ||
        b.candidate.confidence - a.candidate.confidence ||
        a.candidate.title.localeCompare(b.candidate.title),
    )[0] ?? null
  );
}

function whyFactsFor(fitted: Fitted): string[] {
  const facts: string[] = [];
  const price = priceBandLabel(fitted.candidate.priceLevel);
  if (fitted.candidate.priceLevel === 'free') facts.push('free');
  else if (price) facts.push(`paid (${price})`);

  if (fitted.candidate.indoorOutdoor === 'indoor' || fitted.candidate.indoorOutdoor === 'outdoor') {
    facts.push(fitted.candidate.indoorOutdoor);
  }
  // An age claim only where there is a band we could read.
  if (fitted.band !== null && fitted.candidate.ageRange) {
    facts.push(`for ${fitted.candidate.ageRange.trim()}`);
  }
  return facts.slice(0, MAX_WHY_FACTS);
}

function swapTo(
  input: DecideNudgeInput,
  slot: { day: WeekendDay; date: string },
  weatherFact: string,
  admits: (candidate: RadarCandidate) => boolean,
): WeatherSwapNudge | null {
  const fitted = fittedFor(input, slot.date, admits);
  if (!fitted) return null;
  return {
    kind: 'weather_swap',
    candidateRef: {
      id: fitted.candidate.id,
      title: fitted.candidate.title,
      venueName: fitted.candidate.venueName,
    },
    day: slot.day,
    kidNames: namesOf(input.children, fitted.coverage),
    weatherFact,
    whyFacts: whyFactsFor(fitted),
  };
}

/** The first of these days that has something honest to swap to. Every eligible day is
 * tried, not just the first: a dated indoor option on Sunday is still the right nudge
 * when Saturday is also washed out but empty. */
function firstSwap(
  days: ReadonlyArray<{ slot: { day: WeekendDay; date: string }; fact: string }>,
  input: DecideNudgeInput,
  admits: (candidate: RadarCandidate) => boolean,
): WeatherSwapNudge | null {
  for (const { slot, fact } of days) {
    const swap = swapTo(input, slot, fact, admits);
    if (swap) return swap;
  }
  return null;
}

function decideWeatherSwap(input: DecideNudgeInput): WeatherSwapNudge | null {
  // A household with only 13+ children gets no weekend suggestion at all: there is
  // nothing Hale could say about their weekend that rule #1 permits over this channel.
  // (M8 moved this guard here from the caller, which now has to keep looking on behalf
  // of the health checkpoints — those DO apply to a teenager, generically.)
  if (input.children.length === 0) return null;

  // Only the weekend days we actually have a forecast for. With none, there is no
  // weather fact to act on and therefore no weather swap — a "might be nice out"
  // message is a guess dressed as a service.
  const forecast = upcomingWeekend(input.now, input.timeZone)
    .map((slot) => ({ ...slot, outlook: input.weather.find((day) => day.date === slot.date) }))
    .filter(
      (slot): slot is { day: WeekendDay; date: string; outlook: DailyOutlook } =>
        slot.outlook !== undefined,
    );
  if (forecast.length === 0) return null;

  // A good day is the better nudge: it costs a family nothing and it expires. When one
  // exists, an indoor swap is not on the table at all — the weather is not the story.
  const fine = forecast.filter((slot) => isOutdoorFriendly(slot.outlook));
  if (fine.length > 0) {
    return firstSwap(
      fine.map((slot) => ({ slot, fact: DRY_FACT })),
      input,
      (candidate) => candidate.indoorOutdoor === 'outdoor' && candidate.priceLevel === 'free',
    );
  }

  // Every forecast day is a write-off outdoors. An INDOOR label is required — an
  // unlabelled venue cannot be described as indoor, which is the whole swap.
  return firstSwap(
    forecast.flatMap((slot) => {
      const blocker = outdoorBlocker(slot.outlook);
      return blocker ? [{ slot, fact: WEATHER_FACT[blocker] }] : [];
    }),
    input,
    (candidate) => candidate.indoorOutdoor === 'indoor',
  );
}

export function decideNudge(input: DecideNudgeInput): Nudge | null {
  return decideRegistration(input) ?? decideHealthCheckpoint(input) ?? decideWeatherSwap(input);
}
