import { stageFromAgeInMonths } from '@hale/types';
import type { VerifiedSchoolBreak, WeekdayCareContext } from '~/lib/care/weekday';
import {
  type AgeBand,
  type RadarCandidate,
  type RadarChild,
  type WeekendDay,
  asciiSpaces,
  coverageOf,
  parseAgeRange,
  upcomingWeekend,
  weekdayOf,
} from '~/lib/channel/intake/radar-decide';
import {
  type WeekdayFinderAsk,
  printableWeekdayName,
  renderWeekdayFinderAsk,
  weekdayVerifiedBreakAsk,
} from '~/lib/channel/nudge/weekday-care-copy';
import { OPT_OUT_LINE } from '~/lib/channel/opt-out';
import { isPrintableGsm7Basic, smsSegments } from '~/lib/channel/sms-segments';
import { CIVIC_SOURCE } from '~/lib/civic/project';
import { dayKeyOf, formatWhenPhrase } from '~/lib/format/datetime';
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

/** The five days the weekend rule throws away. A closed set, so a fact slot can be
 * checked exhaustively wherever it appears. */
export type WeekdayName = 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday';

const WEEKDAY_NAMES: Record<number, WeekdayName> = {
  1: 'monday',
  2: 'tuesday',
  3: 'wednesday',
  4: 'thursday',
  5: 'friday',
};

/**
 * VIL-360 · a WEEKDAY drop-in, for a household whose child is home midweek.
 *
 * These rows are already in this family's feed and the weekend rule discards them:
 * the civic sweep ingests EarlyON weekday mornings and library storytimes into
 * `village_candidates` under `run_type = 'civic'`, and both surfaces that send
 * unprompted finds - the intake radar's `placements` and the weather swap's
 * `fittedFor` - independently require a Saturday or a Sunday. This is a filter over
 * data already on the row, not a new source.
 */
export interface WeekdayDropInNudge {
  kind: 'weekday_dropin';
  /** The id is for us; the title/venue are the only renderable parts. */
  candidateRef: { id: string; title: string; venueName: string | null };
  /** The session's own family-local day key, and the weekday name derived from it.
   * Both ride along because the composer may only restate a fact this file emitted,
   * and the name is the one a parent reads. */
  eventDate: string;
  weekday: WeekdayName;
  kidNames: string[];
}

/**
 * The weekday finder ask. Age and stage choose the sentence. They do not decide
 * whether the family is asked.
 *
 * A verified break is its own anchor (the date on the event). Every other prompt
 * still rests on a weekend-options send Hale actually delivered. Neither path
 * claims weekends are covered, and neither path invents a PA day.
 */
export interface WeekdayCareAsk {
  kind: 'weekday_care';
  ask: WeekdayFinderAsk;
}

export type Nudge =
  | RegistrationNudge
  | HealthCheckpointNudge
  | WeatherSwapNudge
  | WeekdayDropInNudge
  | WeekdayCareAsk;

/**
 * WHAT THE WEEKDAY LEGS KNOW ABOUT THIS HOUSEHOLD, or the one word that says the
 * behaviour is not armed.
 *
 * `'disarmed'` is a named state rather than an absent dependency (rule #11): the two
 * weekday legs do not run and emit NO skip counters at all, so a SILENT counter means
 * the flag is off, where a zero counter would have meant the legs ran and found
 * nothing. Those are different facts and the probe reads both.
 */
export type WeekdayCareInput = WeekdayCareContext | 'disarmed';

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
  /** Checkpoints the family must not be raised about again (already told, or done). */
  suppressedCheckpointRefs: ReadonlySet<string>;
  /**
   * Registration windows an M7 sequence (VIL-242) has claimed for this family. The
   * sequence sends its own heads-up leg for a window it is preparing, so announcing it
   * here too would be the same news twice from the same number. Per WINDOW, never per
   * family: a claim defers one date, it does not mute the class.
   */
  claimedWindowIds: ReadonlySet<string>;
  /** VIL-360 — the weekday legs' inputs, or `'disarmed'`. See {@link WeekdayCareInput}. */
  weekdayCare: WeekdayCareInput;
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
  // THIS family must act, so the soonest UNCLAIMED one is the only one worth
  // considering — a claimed window is M7's to announce, and skipping to the next
  // candidate (rather than returning null) is what keeps a claim from silencing the
  // whole class for the family.
  const match = input.windows.find((candidate) => !input.claimedWindowIds.has(candidate.window.id));
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
    suppressedRefs: input.suppressedCheckpointRefs,
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

// ── priority 4: a weekday civic drop-in ──────────────────────────────────────

/**
 * Why `decideWeekdayDropIn` had nothing to offer. Every one of these is a DIFFERENT
 * state and none of them may share a bucket (rule #11) — "the parent said daycare"
 * and "nobody has told us" call for opposite next moves, and folding them into one
 * `care_not_home` is what rev 1 of this design did.
 */
export type WeekdayDropInSkip =
  /** A live fact says daycare. `starting_soon` does NOT skip — a child who starts in
   * September is home now, which is exactly the household this is for. */
  | 'care_is_daycare'
  /** No fact at all. The ordinary state, and the one the ask exists to change. */
  | 'care_unstated'
  | 'no_civic_candidate'
  | 'no_weekday_date'
  /** A Mon-Fri row the weekly sweep has not re-dated yet — see {@link decideWeekdayDropIn}. */
  | 'weekday_date_past'
  /** A candidate dropped rather than sent as UCS-2. Counted, and another may still win. */
  | 'not_gsm7_printable';

/** decideWeekdayCareAsk's reasons. */
export type WeekdayCareAskSkip =
  | 'already_asked'
  | 'no_weekend_find_sent'
  | 'already_stated'
  /** A verified break was supplied but its label cannot be sent as GSM-7. */
  | 'break_label_unusable'
  /** The verified date is already past. Counted, and another prompt may still go. */
  | 'break_not_upcoming'
  /** No child on the roster this ask could be about. */
  | 'no_children'
  /** A school-age name could not be printed. COUNTED, and the household sentence goes. */
  | 'name_not_printable';

export type NudgeSkipReason = WeekdayDropInSkip | WeekdayCareAskSkip;

export type NudgeSkipCounts = Partial<Record<NudgeSkipReason, number>>;

/**
 * What the whole decide produced: the one thing worth texting, and every reason a leg
 * counted on the way there.
 *
 * `skips` RIDES ALONG WITH A NUDGE TOO, rather than being the alternative to one. A leg
 * can both produce a nudge and count a refusal — an unprintable candidate dropped
 * before a later one won, a child name that had to go generic — and a shape where the
 * counter only exists on the silent branch would lose exactly those, which is the
 * bucket-that-means-something-else defect this counter exists to remove.
 *
 * The three original legs are NOT retrofitted with reasons. They return null today,
 * this change does not own them, and half-retrofitting is how a counter starts lying
 * about which legs it covers — so an empty `skips` is honest (it says nothing about a
 * leg that reports nothing) and the retrofit is its own ticket.
 */
export interface NudgeDecision {
  nudge: Nudge | null;
  skips: NudgeSkipCounts;
}

/** One leg's answer: what it produced, and every reason it counted getting there. A
 * leg can produce a nudge AND count a reason — a dropped candidate, a name that had
 * to go generic — so these are not alternatives. */
interface LegOutcome<T> {
  nudge: T | null;
  skips: readonly NudgeSkipReason[];
}

function bump(counts: NudgeSkipCounts, reasons: readonly NudgeSkipReason[]): void {
  for (const reason of reasons) counts[reason] = (counts[reason] ?? 0) + 1;
}

/** Renderable here means the strings this nudge actually puts in a message. The
 * candidate's `summary` is not among them and is not even selected by the reader, so
 * guarding it would be a check that always passes; if a later change renders it, it
 * adds the column AND this guard in the same commit. */
function renderablePrintable(candidate: RadarCandidate): boolean {
  if (!isPrintableGsm7Basic(candidate.title)) return false;
  return candidate.venueName === null || isPrintableGsm7Basic(candidate.venueName);
}

/**
 * THE OFFER ITSELF, with no care gate in front of it: is there a weekday session this
 * family could be sent today or later?
 *
 * Split out because BOTH weekday legs need exactly this question and they need it for
 * opposite reasons. The find asks it about a household that HAS said its child is home;
 * the ask asks it about a household that has said nothing, to be sure it can pay off a
 * "home with me" before it puts the question. One predicate, called twice - a second
 * copy is how "Hale asks" and "Hale can deliver" start disagreeing.
 */
function availableWeekdayDropIn(input: DecideNudgeInput): LegOutcome<WeekdayDropInNudge> {
  const teen = new Set(input.teenChildIds);
  const civic = input.candidates.filter(
    (candidate) =>
      candidate.source === CIVIC_SOURCE &&
      (candidate.childId === null || !teen.has(candidate.childId)),
  );
  if (civic.length === 0) return { nudge: null, skips: ['no_civic_candidate'] };

  const weekdays = civic.filter((candidate) => {
    if (candidate.eventDate === null) return false;
    const dow = weekdayOf(candidate.eventDate);
    return dow >= 1 && dow <= 5;
  });
  if (weekdays.length === 0) return { nudge: null, skips: ['no_weekday_date'] };

  const today = dayKeyOf(input.now, input.timeZone);
  const ahead = weekdays.filter((candidate) => (candidate.eventDate as string) >= today);
  if (ahead.length === 0) return { nudge: null, skips: ['weekday_date_past'] };

  const skips: NudgeSkipReason[] = [];
  const printable: RadarCandidate[] = [];
  for (const candidate of ahead) {
    if (renderablePrintable(candidate)) printable.push(candidate);
    else skips.push('not_gsm7_printable');
  }
  if (printable.length === 0) return { nudge: null, skips };

  // Soonest first, then the same stable tie-break the weekend pick uses.
  const pick = [...printable].sort(
    (a, b) =>
      (a.eventDate as string).localeCompare(b.eventDate as string) ||
      b.confidence - a.confidence ||
      a.title.localeCompare(b.title),
  )[0] as RadarCandidate;

  const eventDate = pick.eventDate as string;
  return {
    nudge: {
      kind: 'weekday_dropin',
      candidateRef: { id: pick.id, title: pick.title, venueName: pick.venueName },
      eventDate,
      weekday: WEEKDAY_NAMES[weekdayOf(eventDate)] as WeekdayName,
      // Named, never filtered on: a free civic drop-in with a stated band this
      // household misses is still worth naming nobody over, and an extra refusal
      // reason here would be a state nothing acts on.
      kidNames: namesOf(input.children, coverageOf(input.children, parseAgeRange(pick.ageRange))),
    },
    skips,
  };
}

/**
 * The soonest weekday civic session to OFFER this family, or the reasons there is not
 * one.
 *
 * TWO GATES MAKE THE CLAIM SAFE, and each is one comparison.
 *
 * `source === CIVIC_SOURCE`, because this message asserts a DAY. A civic row is dated
 * by the sweep from a feed it verified and its strings are built deterministically; an
 * LLM-discovered row's date and url are frequently model output (village/discover.ts),
 * and a wrong Tuesday is a family standing outside a library.
 *
 * `eventDate >= today`, because `nextOccurrenceDay` dates a session to its next
 * occurrence AT THE MOMENT THE SWEEP RUNS, and that sweep runs weekly on Monday. A
 * Tuesday storytime projected on Monday still reads as that Tuesday on Saturday, so
 * without this clause a soonest-first pick texts LAST Tuesday's session. The weather
 * swap never hits this because its date is drawn from `upcomingWeekend` and is a
 * future date by construction; the weekday branch has no such anchor.
 *
 * THE COST, NAMED: the weekday offer therefore exists mostly on Monday, Tuesday and
 * Wednesday ticks. That is correct behaviour and it will be mistaken for a bug.
 */
export function decideWeekdayDropIn(input: DecideNudgeInput): LegOutcome<WeekdayDropInNudge> {
  if (input.weekdayCare === 'disarmed') return { nudge: null, skips: [] };

  // Only a fact about a child this channel may speak about at all. A 13+ child's
  // fact could only exist through a direct call, and it must not unlock a find.
  const teen = new Set(input.teenChildIds);
  const stated = input.weekdayCare.stated.filter((fact) => !teen.has(fact.childId));
  if (stated.length === 0) return { nudge: null, skips: ['care_unstated'] };
  if (!stated.some((fact) => fact.care === 'home' || fact.care === 'starting_soon')) {
    return { nudge: null, skips: ['care_is_daycare'] };
  }

  return availableWeekdayDropIn(input);
}

// ── priority 5: the weekday-care ask ─────────────────────────────────────────

const BREAK_EVENT_KEY = /^[a-z0-9]+(?:-[a-z0-9]+)*-\d{4}-\d{2}-\d{2}$/;

function breakAskFits(label: string): boolean {
  if (!isPrintableGsm7Basic(label)) return false;
  if (label.length === 0 || label.length > 40 || label.includes('?') || label.includes('\n')) {
    return false;
  }
  const sentence = weekdayVerifiedBreakAsk(label);
  return smsSegments(`${sentence}\n\n${OPT_OUT_LINE}`) === 1;
}

/**
 * Which sentence this roster should hear, before the ledger checks.
 *
 * One school-age child under 13, and nobody else: the named after-school ask.
 * Everyone 13+: the household after-school ask, which prints no name.
 * Anything else (toddler, preschool, mixed, several school-age children): the
 * weekend fallback, which also prints no name. Preschool is not treated as
 * in-school — there is no enrollment source to know that a four-year-old is.
 */
function classifyWeekdayRoster(
  children: readonly HealthChild[],
):
  | { kind: 'after_school_named'; child: HealthChild }
  | { kind: 'after_school_household' }
  | { kind: 'weekend_fallback' } {
  const school = children.filter((child) => {
    if (child.isTeen || child.ageMonths === null) return false;
    return stageFromAgeInMonths(child.ageMonths) === 'child';
  });
  const teens = children.filter((child) => child.isTeen);
  const others = children.length - school.length - teens.length;
  if (school.length === 1 && teens.length === 0 && others === 0) {
    const child = school[0];
    if (child) return { kind: 'after_school_named', child };
  }
  if (children.length > 0 && teens.length === children.length) {
    return { kind: 'after_school_household' };
  }
  return { kind: 'weekend_fallback' };
}

function upcomingBreak(
  verified: VerifiedSchoolBreak | null | undefined,
  today: string,
): { ask: WeekdayFinderAsk } | { skip: 'break_label_unusable' | 'break_not_upcoming' } | null {
  if (verified == null) return null;
  if (verified.date < today) return { skip: 'break_not_upcoming' };
  if (!BREAK_EVENT_KEY.test(verified.eventKey) || !breakAskFits(verified.label)) {
    return { skip: 'break_label_unusable' };
  }
  if (!verified.eventKey.endsWith(verified.date)) return { skip: 'break_label_unusable' };
  return {
    ask: { prompt: 'verified_break', eventKey: verified.eventKey, label: verified.label },
  };
}

/**
 * The finder ask, or the reason there is not one.
 *
 * A verified break outranks the other prompts: it is the current moment, and it
 * fires only from a break the caller verified. Age and postal code never produce
 * one. The other prompts still require a weekend-options send. A care fact
 * suppresses the fallback (the household already answered that question) and
 * does not suppress an after-school ask, and it never unlocks a civic drop-in
 * by itself — that gate stays on `decideWeekdayDropIn`.
 */
export function decideWeekdayCareAsk(input: DecideNudgeInput): LegOutcome<WeekdayCareAsk> {
  if (input.weekdayCare === 'disarmed') return { nudge: null, skips: [] };
  const context = input.weekdayCare;
  const skips: NudgeSkipReason[] = [];
  const today = dayKeyOf(input.now, input.timeZone);
  const breakOutcome = upcomingBreak(context.verifiedBreak, today);
  if (breakOutcome && 'ask' in breakOutcome && breakOutcome.ask.prompt === 'verified_break') {
    const asked = context.askedBreakKeys ?? [];
    if (!asked.includes(breakOutcome.ask.eventKey)) {
      return { nudge: { kind: 'weekday_care', ask: breakOutcome.ask }, skips };
    }
  } else if (breakOutcome && 'skip' in breakOutcome) {
    skips.push(breakOutcome.skip);
  }

  if (input.healthChildren.length === 0) {
    return { nudge: null, skips: [...skips, 'no_children'] };
  }

  const roster = classifyWeekdayRoster(input.healthChildren);
  if (roster.kind === 'weekend_fallback') {
    if (context.askedBefore) return { nudge: null, skips: [...skips, 'already_asked'] };
    if (!context.weekendFindSent) return { nudge: null, skips: [...skips, 'no_weekend_find_sent'] };
    if (context.stated.length > 0) return { nudge: null, skips: [...skips, 'already_stated'] };
    return { nudge: { kind: 'weekday_care', ask: { prompt: 'weekend_fallback' } }, skips };
  }

  if (context.askedAfterSchool) return { nudge: null, skips: [...skips, 'already_asked'] };
  if (!context.weekendFindSent) return { nudge: null, skips: [...skips, 'no_weekend_find_sent'] };

  if (roster.kind === 'after_school_household') {
    return { nudge: { kind: 'weekday_care', ask: { prompt: 'after_school_household' } }, skips };
  }

  const name = printableWeekdayName(roster.child.name);
  if (name === null) {
    return {
      nudge: { kind: 'weekday_care', ask: { prompt: 'after_school_household' } },
      skips: [...skips, 'name_not_printable'],
    };
  }
  const ask: WeekdayFinderAsk = {
    prompt: 'after_school_named',
    childId: roster.child.id,
    name,
  };
  if (smsSegments(`${renderWeekdayFinderAsk(ask)}\n\n${OPT_OUT_LINE}`) > 1) {
    return {
      nudge: { kind: 'weekday_care', ask: { prompt: 'after_school_household' } },
      skips: [...skips, 'name_not_printable'],
    };
  }
  return { nudge: { kind: 'weekday_care', ask }, skips };
}

/**
 * THE LADDER, and the two new rungs sit at the bottom of it on purpose.
 *
 * A weather swap only fires when a forecast makes one weekend option clearly better —
 * a genuinely expiring fact. A weekly EarlyON drop-in recurs, so losing a week costs
 * almost nothing, and the weekday find ranks below it. The ASK ranks last of all
 * because it is a cost rather than a payoff: it may only occupy a week Hale would
 * otherwise have been silent in, which this file's own header calls the most common
 * correct outcome.
 */
export function decideNudge(input: DecideNudgeInput): NudgeDecision {
  const skips: NudgeSkipCounts = {};

  const registration = decideRegistration(input);
  if (registration) return { nudge: registration, skips };

  const health = decideHealthCheckpoint(input);
  if (health) return { nudge: health, skips };

  const swap = decideWeatherSwap(input);
  if (swap) return { nudge: swap, skips };

  const dropIn = decideWeekdayDropIn(input);
  bump(skips, dropIn.skips);
  if (dropIn.nudge) return { nudge: dropIn.nudge, skips };

  const ask = decideWeekdayCareAsk(input);
  bump(skips, ask.skips);
  if (ask.nudge) return { nudge: ask.nudge, skips };

  return { nudge: null, skips };
}
