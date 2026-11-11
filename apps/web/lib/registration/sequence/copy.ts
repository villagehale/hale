import { asciiSpaces } from '~/lib/channel/intake/radar-decide';
import { townLabel } from '~/lib/channel/intake/radar-voice';
import type { SpotPortal } from '~/lib/channel/spots/url';
import { dayKeyIn } from '~/lib/plan/spine';
import type { DateMovedFacts } from './date-moved-compose.js';
import type { DateUnconfirmedFacts } from './date-unconfirmed-compose.js';
import type { Moment, RegistrationNoteFacts } from './note-compose.js';
import type { CourseBindRefusal } from './prepare-reply.js';
import {
  type ApplicableClock,
  type CoursePage,
  type PrepVerdict,
  WINDOW_DRIFT_TOLERANCE_MINUTES,
  courseSignInUrl,
  priceClause,
} from './prepare.js';
import {
  GO_LEAD_MINUTES,
  HEADS_UP_LEAD_DAYS,
  READINESS_LEAD_DAYS,
  type SequenceLeg,
  type SequenceOptIn,
  WAITLIST_FINAL_LEAD_HOURS,
  openTimeIsPublished,
  waitlistDeadline,
} from './schedule.js';
import type { FitNote, Shortlist } from './shortlist.js';

/**
 * VIL-242 · M7 — the facts every registration message is written from. NO SENTENCE IS
 * BUILT HERE (VIL-484, VIL-488, VIL-543): the model writes every text from these facts,
 * and a text that cannot be written sends nothing. The heads-up, evening and morning-of
 * texts have their own composers; everything else goes through note-compose.ts.
 *
 * The `asciiSpaces` wrapper exists because Intl renders "6:30 a.m." with a NARROW
 * NO-BREAK SPACE, which is not GSM-7.
 */

/** THIS tick's reading of the bound course, and the link it was read from. */
export interface PrepCopyInput {
  /** The verdict `readCoursePrep` returned for this send. */
  verdict: PrepVerdict;
  /** The stored sanitized course URL. Code-appended, never model-written, and the only
   * string the prepared templates print that did not come from this tick's bytes. */
  courseUrl: string;
}

export interface LegCopyInput {
  shortlist: Shortlist;
  timeZone: string;
  now: Date;
  optIn: SequenceOptIn;
  /**
   * The instant this ladder is running on — the course page's own clock
   * (`course_opens_at`) where a course is bound, the M1 row's family open otherwise.
   * The SAME instant `openLegWindows` derived this leg's interval from, so the sentence
   * and the schedule can never name two different mornings. Every battle-plan and go
   * sentence that names a morning names THIS one; the two exceptions are the branches
   * whose whole content is that the page now shows another (`window_moved`,
   * `late_by_drift`), and they say so in both instants.
   */
  anchor: Date;
  /** The registry portal for this window's municipality, or null for the thirteen Hale
   * cannot read. Required-but-nullable (rule #11): the absence of a portal is a state
   * with its own copy, never a default a caller can fall into by forgetting. */
  portal: SpotPortal | null;
  /** What the parent TOLD Hale about their own portal setup. Null is "never answered",
   * which is a different sentence from "answered no" nowhere — both are the absence of
   * a claim, and the copy attributes both to the parent. */
  readinessReady: boolean | null;
  /** THIS tick's course reading, or null where no course is bound and where the leg
   * does not read one. */
  prep: PrepCopyInput | null;
  /** Present only for the two waitlist guards. */
  waitlist?: { position: number | null; startedAt: Date | null };
}

export type CheckInReplyRender =
  | { outcome: 'registered' }
  | { outcome: 'waitlisted'; position: number | null; startedAt: Date }
  | { outcome: 'missed' };

export interface CheckInReplyInput {
  shortlist: Shortlist;
  timeZone: string;
  now: Date;
  reply: CheckInReplyRender;
}

/** Just the time of day, for a leg whose sentence already carries the day. */
function timeOfDay(instant: Date, timeZone: string): string {
  return asciiSpaces(
    new Intl.DateTimeFormat('en-CA', {
      hour: 'numeric',
      minute: '2-digit',
      timeZone,
    }).format(instant),
  );
}

function joinNames(names: readonly string[]): string {
  if (names.length === 0) return '';
  if (names.length === 1) return names[0] as string;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * Who the window is for, in one phrase. A 13+ child is counted, never named (rule #1) —
 * the generic wording is what M8 established for a teenager's own paperwork, and the
 * reason is identical: the deadline is real whether or not Hale may say the name.
 */
function whoPhrase(fitNotes: readonly FitNote[]): string {
  // VIL-338 · a BOUND course reaches here with no fit notes at all: the parent picked
  // that class and the M1 band no longer admits anybody, which is a fact about the
  // reference row rather than about the household. "your family" is the one phrase that
  // is true of them without naming a child the band excluded.
  if (fitNotes.length === 0) return 'your family';
  const named = fitNotes.map((note) => note.name).filter((name): name is string => name !== null);
  const teens = fitNotes.length - named.length;
  const parts: string[] = [];
  if (named.length > 0) parts.push(joinNames(named));
  if (teens > 0) parts.push(teens === 1 ? 'your teen' : 'your teens');
  return parts.join(' and ');
}

/**
 * "Richmond Hill Fall 2026 recreation programs" — the window, as a parent reads it.
 * The cycle phrase is built once, in shortlist.ts: this used to append the domain
 * label to the cycle label unconditionally, which rendered Burlington's own
 * "Fall 2026 swimming lessons" as "Fall 2026 swimming lessons swim lessons".
 */
export function windowPhrase(shortlist: Shortlist): string {
  return `${townLabel(shortlist.windowRef.municipality)} ${shortlist.cyclePhrase}`;
}

/**
 * MEM-10 · whether the heads-up leg's closing line is a PROMISE rather than an
 * invitation. Exported so the sentence and the open-loops ledger cannot drift apart: an
 * unapproved household is being ASKED to approve, and Hale owes them nothing until they
 * do — recording a debt against that wording would report a broken promise nobody made.
 */
export function headsUpPromisesPlan(optIn: SequenceOptIn): boolean {
  return optIn === 'opted_in';
}

/** Just the day and month, for the ack's one sub-clause that names a date without an
 * hour — the residents-first date a household on the public clock does not open on. */
function dateOnly(instant: Date, timeZone: string): string {
  return asciiSpaces(
    new Intl.DateTimeFormat('en-CA', { month: 'short', day: 'numeric', timeZone }).format(instant),
  );
}

/**
 * Whether this leg's body carries the readiness ask. Exported so the copy and the
 * open-question ledger cannot drift: the question is open only while its ask is Hale's
 * last word, and "was there an ask" is answered from the dedupe keys of the legs this
 * predicate names.
 *
 * KNOWN IMPRECISION, bounded on purpose, and it has TWO causes rather than one. A
 * battle plan that degraded to a failure sentence (the course gone, the page closed,
 * the clock moved to another day) has no room for the ask and prints none; and a battle
 * plan for a parent who already answered YES carries no imperative either. Both still return true for that leg's key, which is why the source
 * that reads this predicate must ALSO require `readiness_ready IS DISTINCT FROM true`
 * and the last-word rule — dropping either of those on the strength of this function
 * alone would open a question against a text that asked nothing. What the overstatement
 * costs where it survives both filters is one bare YES filed against a question the
 * parent did not quite see: an answer that is still attributed, on a leg whose own
 * sentence told them something went wrong.
 */
export function printsReadinessAsk(leg: SequenceLeg, portal: SpotPortal | null): boolean {
  return portal !== null && (leg === 'readiness' || leg === 'battle_plan');
}

/** A page string Hale may print, or null. The reader has already dropped anything the
 * bytes did not back or a phone could not carry; this is the composer refusing to
 * print what it was not handed. */
function printable(value: string | null | undefined, backed: readonly string[]): string | null {
  if (typeof value !== 'string') return null;
  return backed.includes(value) ? value : null;
}

/** Facts for the heads-up leg (a week out). There is no code sentence: the model writes
 * the whole text from these, and a draft that fails sends nothing (VIL-488). */
export interface HeadsUpFacts {
  now: { date: string; time: string };
  window: string;
  /** Who the window is for. A 13+ child is already "your teen", never a name. */
  who: string;
  /** When it opens for THIS family, handed in English. */
  opensOn: string;
  opensAt: string;
  /** The family's postal code gets the residents-first date. */
  residentsFirst: boolean;
  /** The match may rest on an age derived from a spoken age: hedge the band. */
  ageApproximate: boolean;
  /** `plan_promised`: an opted-in household; Hale sends the plan the evening before.
   * `offer`: not yet approved; ask whether Hale should run the morning with them
   * (a YES in this thread approves it). */
  next: 'plan_promised' | 'offer';
}

export function headsUpFacts(input: LegCopyInput): HeadsUpFacts {
  const { shortlist } = input;
  const opens = shortlist.opensForFamilyAt;
  return {
    now: {
      date: writtenDate(input.now, input.timeZone),
      time: timeOfDay(input.now, input.timeZone),
    },
    window: windowPhrase(shortlist),
    who: whoPhrase(shortlist.fitNotes),
    opensOn: writtenDate(opens, input.timeZone),
    opensAt: timeOfDay(opens, input.timeZone),
    residentsFirst: shortlist.isResidentWindow && shortlist.residentPriorityDays !== null,
    ageApproximate: shortlist.ageApproximate,
    next: headsUpPromisesPlan(input.optIn) ? 'plan_promised' : 'offer',
  };
}

export type EveningSituation =
  | 'municipal'
  | 'course'
  | 'page_unreadable'
  | 'course_gone'
  | 'registration_closed'
  | 'age_outside'
  | 'already_open'
  | 'moved_day';

/**
 * Facts for the evening-before registration text. English date and clock labels
 * are facts the model restates in the parent's language. They are never sent.
 */
export interface EveningFacts {
  now: { date: string; time: string };
  window: string;
  /** Who the window is for. A 13+ child is already "your teen", never a name. */
  who: string;
  opensAt: string;
  opensOn: string;
  /** The one URL the text may carry, or null. */
  link: string | null;
  portal: string | null;
  /** Null when this evening does not speak about portal setup. */
  setup: 'told_done' | 'not_told' | null;
  situation: EveningSituation;
  courseName: string | null;
  ageBand: string | null;
  children: number;
  /** The clock the page shows now, when it disagrees with `opensAt`/`opensOn`:
   * already open since (`already_open`) or opening on another day (`moved_day`).
   * Null in every other situation. */
  pageShows: { date: string; time: string } | null;
}

export type BattlePlanDecision = { kind: 'compose'; facts: EveningFacts };

function writtenDate(instant: Date, timeZone: string): string {
  return asciiSpaces(
    new Intl.DateTimeFormat('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      year: 'numeric',
      timeZone,
    }).format(instant),
  );
}

function setupFact(ready: boolean | null, portal: SpotPortal | null): EveningFacts['setup'] {
  if (portal === null) return null;
  return ready === true ? 'told_done' : 'not_told';
}

function composeEvening(
  input: LegCopyInput,
  portal: SpotPortal | null,
  situation: EveningSituation,
  link: string | null,
  extra: {
    courseName?: string | null;
    ageBand?: string | null;
    opensAt?: string;
    pageShows?: Date;
  } = {},
): BattlePlanDecision {
  return {
    kind: 'compose',
    facts: {
      now: {
        date: writtenDate(input.now, input.timeZone),
        time: timeOfDay(input.now, input.timeZone),
      },
      window: windowPhrase(input.shortlist),
      who: whoPhrase(input.shortlist.fitNotes),
      opensAt: extra.opensAt ?? timeOfDay(input.anchor, input.timeZone),
      opensOn: writtenDate(input.anchor, input.timeZone),
      link,
      portal: portal?.portalLabel ?? null,
      setup: setupFact(input.readinessReady, portal),
      situation,
      courseName: extra.courseName ?? null,
      ageBand: extra.ageBand ?? null,
      children: input.shortlist.fitNotes.length,
      pageShows:
        extra.pageShows === undefined
          ? null
          : {
              date: writtenDate(extra.pageShows, input.timeZone),
              time: timeOfDay(extra.pageShows, input.timeZone),
            },
    },
  };
}

/**
 * The evening-before plan. Always facts only: the model writes the text, and a
 * draft that cannot be written sends nothing.
 */
export function battlePlanDecision(input: LegCopyInput): BattlePlanDecision {
  const portal = input.portal ?? null;
  const prep = input.prep;
  if (portal !== null && prep !== null) {
    const prepared = preparedDecision(input, prep, portal);
    if (prepared) return prepared;
  }
  return composeEvening(input, portal, 'municipal', input.shortlist.sourceUrl);
}

/**
 * A bound course's evening plan. Null where the stored URL will not mint a
 * sign-in link — that URL is not treated as a bound course, and the caller
 * hands the municipal facts instead.
 */
function preparedDecision(
  input: LegCopyInput,
  prep: PrepCopyInput,
  portal: SpotPortal,
): BattlePlanDecision | null {
  const link = courseSignInUrl(prep.courseUrl);
  if (link === null) return null;
  const verdict = prep.verdict;
  const municipal = input.shortlist.sourceUrl;

  switch (verdict.kind) {
    case 'page_unreadable':
      // It does not wait for a better read: the go leg re-reads in the morning,
      // and the facts say the page could not be read. No class detail is handed.
      return composeEvening(input, portal, 'page_unreadable', prep.courseUrl);
    case 'course_gone':
      return composeEvening(input, portal, 'course_gone', municipal);
    case 'registration_closed':
      return composeEvening(input, portal, 'registration_closed', municipal);
    case 'late_by_drift': {
      const clock = verdict.clock;
      if (clock === null) return composeEvening(input, portal, 'municipal', municipal);
      return composeEvening(input, portal, 'already_open', link, {
        courseName: printable(verdict.facts.EventName, verdict.backed),
        pageShows: clock.at,
      });
    }
    case 'age_ineligible':
      return composeEvening(input, portal, 'age_outside', prep.courseUrl, {
        ageBand: printable(verdict.facts.AgeRestrictions, verdict.backed),
        courseName: printable(verdict.facts.EventName, verdict.backed),
      });
    case 'window_moved': {
      const clock = verdict.clock;
      if (clock === null) return composeEvening(input, portal, 'municipal', municipal);
      // A move inside the same local day is the ordinary plan at the new time.
      // A move to another day is news, and the key is spent, so this is the only
      // evening text that says the morning moved.
      if (dayKeyIn(clock.at, input.timeZone) !== dayKeyIn(input.anchor, input.timeZone)) {
        return composeEvening(input, portal, 'moved_day', prep.courseUrl, {
          courseName: printable(verdict.facts.EventName, verdict.backed),
          pageShows: clock.at,
        });
      }
      return composeEvening(input, portal, 'course', prep.courseUrl, {
        courseName: printable(verdict.facts.EventName, verdict.backed),
        opensAt: timeOfDay(clock.at, input.timeZone),
      });
    }
    case 'prepared':
      // The ANCHOR, not this read's clock. `prepared` agrees with the anchor
      // within WINDOW_DRIFT_TOLERANCE_MINUTES, so the page's own instant would
      // put up to fifteen minutes between this text and the go leg.
      return composeEvening(input, portal, 'course', prep.courseUrl, {
        courseName: printable(verdict.facts.EventName, verdict.backed),
      });
  }
}

/** What the morning-of text is about. The model writes the whole text from it.
 * - `opens`: the window opens at `had`; the link is the one place to go.
 * - `page_unreadable`: Hale could not read the course page this morning.
 * - `course_gone`: the page no longer shows the course the parent sent.
 * - `registration_closed`: the page shows the course closed to online registration.
 * - `age_ineligible`: the page's age band excludes the birthday(s) Hale holds.
 * - `moved`: the page shows another open time, `pageShows`.
 * - `already_open`: the page shows the open already passed, at `pageShows`. */
export type MorningSituation =
  | 'opens'
  | 'page_unreadable'
  | 'course_gone'
  | 'registration_closed'
  | 'age_ineligible'
  | 'moved'
  | 'already_open';

/** Facts for EVERY morning-of (go leg) text. There is no code sentence for any of
 * them: the model writes the whole text, and a draft that fails sends nothing. */
export interface MorningFacts {
  now: { date: string; time: string };
  window: string;
  /** The portal's name, or null for a municipality with no portal. */
  portal: string | null;
  /** The one URL the text may carry. */
  link: string;
  situation: MorningSituation;
  /** The time Hale had told the parent. */
  had: string;
  /** Null when this morning does not speak about portal setup. */
  setup: 'told_done' | 'not_told' | null;
  /** The page's own age band, verbatim, only for `age_ineligible` (else null). */
  ageBand: string | null;
  /** How many birthdays Hale holds for this window. */
  children: number;
  /** What the page shows now, only for `moved` / `already_open` (else null). */
  pageShows: { date: string; time: string } | null;
}

export function morningFacts(input: LegCopyInput): MorningFacts {
  const portal = input.portal ?? null;
  const prep = input.prep;
  const base = {
    now: {
      date: writtenDate(input.now, input.timeZone),
      time: timeOfDay(input.now, input.timeZone),
    },
    window: windowPhrase(input.shortlist),
    portal: portal?.portalLabel ?? null,
    had: timeOfDay(input.anchor, input.timeZone),
    setup: setupFact(input.readinessReady, portal),
    ageBand: null,
    children: input.shortlist.fitNotes.length,
    pageShows: null,
  };
  const opens: MorningFacts = {
    ...base,
    link: input.shortlist.sourceUrl,
    situation: 'opens',
  };
  if (portal === null || prep === null) return opens;
  const link = courseSignInUrl(prep.courseUrl);
  if (link === null) return opens;
  const verdict = prep.verdict;
  switch (verdict.kind) {
    case 'prepared':
      return { ...base, link, situation: 'opens' };
    case 'page_unreadable':
      return { ...base, link, situation: 'page_unreadable' };
    case 'course_gone':
      return { ...base, link: prep.courseUrl, situation: 'course_gone', setup: null };
    case 'registration_closed':
      return { ...base, link: prep.courseUrl, situation: 'registration_closed', setup: null };
    case 'age_ineligible':
      return {
        ...base,
        link,
        situation: 'age_ineligible',
        ageBand: printable(verdict.facts.AgeRestrictions, verdict.backed),
      };
    case 'window_moved':
    case 'late_by_drift': {
      const clock = verdict.clock;
      if (clock === null) return { ...base, link, situation: 'opens' };
      return {
        ...base,
        link,
        situation: verdict.kind === 'late_by_drift' ? 'already_open' : 'moved',
        pageShows: {
          date: writtenDate(clock.at, input.timeZone),
          time: timeOfDay(clock.at, input.timeZone),
        },
      };
    }
  }
}

function moment(instant: Date, timeZone: string): Moment {
  return { date: writtenDate(instant, timeZone), time: timeOfDay(instant, timeZone) };
}

/**
 * The waitlist clock as the writer is handed it: where the count started (the parent's
 * own message; Hale never sees the offer email) and the deadline counted from there.
 * Both or neither, so a note can never state a deadline without its start.
 */
function waitlistClock(
  startedAt: Date | null,
  responseHours: number | null,
  timeZone: string,
): {
  clockFrom: Moment | null;
  deadline: Moment | null;
  /** Hale never sees the offer email: a running clock started at the parent's message. */
  clockFromSource: 'parent_message' | null;
} {
  const deadline = startedAt === null ? null : waitlistDeadline(startedAt, responseHours);
  if (startedAt === null || deadline === null) {
    return { clockFrom: null, deadline: null, clockFromSource: null };
  }
  return {
    clockFrom: moment(startedAt, timeZone),
    deadline: moment(deadline, timeZone),
    clockFromSource: 'parent_message',
  };
}

/**
 * VIL-543 · facts for the three legs that are not the heads-up, the evening or the
 * morning-of text: the readiness checklist, the check-in and the two waitlist guards.
 * The model writes the whole text (note-compose.ts). There is no code sentence.
 *
 * The readiness checklist carries the news the heads-up would have carried at this
 * hour, because the leg was CARVED OUT of that interval. Its waitlist guards say where
 * the clock came from: the municipality's published window, started by the parent's own
 * message. Hale never sees the offer email.
 */
export function legNoteFacts(
  leg: 'readiness' | 'check_in' | 'waitlist_half' | 'waitlist_final',
  input: LegCopyInput,
): RegistrationNoteFacts {
  const now = moment(input.now, input.timeZone);
  const { shortlist } = input;
  switch (leg) {
    case 'readiness': {
      // `dueLeg` never routes a portal-less sequence here; the runner composes the
      // heads-up from facts for that case.
      if (input.portal == null) {
        throw new Error('registration sequence: a portal-less readiness leg is the heads-up');
      }
      return {
        kind: 'readiness_checklist',
        now,
        window: windowPhrase(shortlist),
        who: whoPhrase(shortlist.fitNotes),
        opensOn: writtenDate(input.anchor, input.timeZone),
        opensAt: timeOfDay(input.anchor, input.timeZone),
        portal: input.portal.portalLabel,
        account: input.portal.accountLabel,
      };
    }
    case 'check_in':
      return { kind: 'check_in_ask', now, window: windowPhrase(shortlist) };
    case 'waitlist_half':
    case 'waitlist_final': {
      const clock = {
        town: townLabel(shortlist.windowRef.municipality),
        responseHours: shortlist.waitlistResponseHours,
        ...waitlistClock(
          input.waitlist?.startedAt ?? null,
          shortlist.waitlistResponseHours,
          input.timeZone,
        ),
      };
      return leg === 'waitlist_half'
        ? { kind: 'waitlist_halfway', now, ...clock }
        : { kind: 'waitlist_final', now, ...clock, hoursLeft: WAITLIST_FINAL_LEAD_HOURS };
    }
  }
}

/**
 * VIL-423 · facts for a dated leg whose stored opening the page did not corroborate.
 * No date and no leg timing are handed: "the evening before" would state the
 * unconfirmed day as surely as the date itself.
 */
export function dateUnconfirmedFacts(
  leg: SequenceLeg,
  input: LegCopyInput,
  why: DateUnconfirmedFacts['why'],
): DateUnconfirmedFacts {
  return {
    now: moment(input.now, input.timeZone),
    window: windowPhrase(input.shortlist),
    who: whoPhrase(input.shortlist.fitNotes),
    why,
    offer: leg === 'heads_up' && !headsUpPromisesPlan(input.optIn),
  };
}

/** VIL-423 · facts for the note a household gets when the page moved an opening Hale
 * already told them. The old opening names a time only where it carried one. */
export function dateMovedFacts(input: {
  shortlist: Shortlist;
  timeZone: string;
  now: Date;
  was: Date;
  opens: Date;
  opensTimePrinted: boolean;
}): DateMovedFacts {
  const { timeZone } = input;
  return {
    now: moment(input.now, timeZone),
    window: windowPhrase(input.shortlist),
    who: whoPhrase(input.shortlist.fitNotes),
    was: {
      date: writtenDate(input.was, timeZone),
      time: openTimeIsPublished(input.was, timeZone) ? timeOfDay(input.was, timeZone) : null,
    },
    opens: {
      date: writtenDate(input.opens, timeZone),
      time: input.opensTimePrinted ? timeOfDay(input.opens, timeZone) : null,
    },
  };
}

/** Facts for Hale's answer to what the parent reported. Solicited. */
export function checkInOutcomeFacts(input: CheckInReplyInput): RegistrationNoteFacts {
  const { shortlist, reply } = input;
  const now = moment(input.now, input.timeZone);
  const town = townLabel(shortlist.windowRef.municipality);
  if (reply.outcome === 'registered') {
    return { kind: 'outcome_registered', now, window: windowPhrase(shortlist) };
  }
  if (reply.outcome === 'missed') return { kind: 'outcome_missed', now, town };
  return {
    kind: 'outcome_waitlisted',
    now,
    town,
    position: reply.position,
    responseHours: shortlist.waitlistResponseHours,
    ...waitlistClock(reply.startedAt, shortlist.waitlistResponseHours, input.timeZone),
  };
}

export interface CourseBindAckInput {
  portal: SpotPortal;
  /** THIS read's page — the facts, and the tokens they were proved by. */
  page: CoursePage;
  /** The clock the bind was decided on: the one THIS family opens on. Passed rather
   * than re-read off the page so the ack cannot name an instant the bind did not use. */
  clock: ApplicableClock;
  /** True where this paste replaced a course already bound. */
  replaced: boolean;
  /** The M1 window this registration morning was proposed from. */
  municipality: string;
  opensForFamilyAt: Date;
  /** Who the morning is for, already stripped of a 13+ child's name (rule #1). */
  fitNotes: readonly FitNote[];
  timeZone: string;
  now: Date;
}

/**
 * Facts for the answer to a parent who just sent a course link: what Hale read off the
 * page. A value the bytes did not back is null, never printed. The M1 row's instant is
 * handed only where it disagrees with the page, so the parent is told in both dates.
 */
export function courseBoundFacts(input: CourseBindAckInput): RegistrationNoteFacts {
  const { page, timeZone } = input;
  const { facts, backed } = page;
  const residents = page.clocks.residents;
  const drift = Math.abs(input.clock.at.getTime() - input.opensForFamilyAt.getTime()) / 60_000;
  const fit = page.age.fit;
  return {
    kind: 'course_bound',
    now: moment(input.now, timeZone),
    replaced: input.replaced,
    portal: input.portal.portalLabel,
    course: {
      name: printable(facts.EventName, backed),
      day: printable(facts.StartDay, backed),
      time: printable(facts.StartTime, backed),
    },
    ageBand: fit === 'unknown' ? null : printable(facts.AgeRestrictions, backed),
    ageFit: fit === 'in_band' ? 'fits' : fit === 'outside_band' ? 'outside' : null,
    who: whoPhrase(input.fitNotes),
    price: priceClause(facts.Prices),
    courseCode: printable(facts.CourseId, backed),
    opensOn: writtenDate(input.clock.at, timeZone),
    opensAt: timeOfDay(input.clock.at, timeZone),
    clockName: input.clock.name,
    residentsOn:
      residents !== null && input.clock.name === 'public date'
        ? dateOnly(residents, timeZone)
        : null,
    haleHad:
      drift > WINDOW_DRIFT_TOLERANCE_MINUTES ? moment(input.opensForFamilyAt, timeZone) : null,
    regForm: facts.RegFormId != null,
    prerequisite: facts.PrerequisiteEvents === true,
  };
}

export interface CourseRefusedInput {
  portal: SpotPortal;
  municipality: string;
  reason: CourseBindRefusal;
  /** The page's own clock, read only on `different_season`. */
  pageOpensAt: Date | null;
  opensForFamilyAt: Date;
  timeZone: string;
  now: Date;
}

/**
 * Facts for the answer to a course link Hale would not bind. No link is handed: the
 * parent has one. Both mornings travel only on a different season, the one reason whose
 * answer is a comparison.
 */
export function courseRefusedFacts(input: CourseRefusedInput): RegistrationNoteFacts {
  const pageOpensAt = input.reason === 'different_season' ? input.pageOpensAt : null;
  return {
    kind: 'course_link_refused',
    now: moment(input.now, input.timeZone),
    reason: input.reason,
    portal: input.portal.portalLabel,
    town: townLabel(input.municipality),
    pageOpens: pageOpensAt === null ? null : moment(pageOpensAt, input.timeZone),
    haleHas: pageOpensAt === null ? null : moment(input.opensForFamilyAt, input.timeZone),
  };
}

/**
 * Facts for the answer to a paste inside a spent read window. Hale does not come back to
 * the link later, so the only time handed is the slot's own remainder — and none for the
 * link already bound, which has nothing to resend.
 */
export function courseThrottledFacts(input: {
  alreadyBound: boolean;
  retryMinutes: number;
  timeZone: string;
  now: Date;
}): RegistrationNoteFacts {
  return {
    kind: 'course_link_throttled',
    now: moment(input.now, input.timeZone),
    alreadyBound: input.alreadyBound,
    retryMinutes: input.alreadyBound ? null : input.retryMinutes,
  };
}

export interface ReadinessAckInput {
  portal: SpotPortal;
  /** What the parent just said. */
  ready: boolean;
  fitNotes: readonly FitNote[];
  timeZone: string;
  now: Date;
}

/**
 * Facts for the answer to a bare YES or NO on the checklist. The skill does not re-ask
 * on a NO: under the last-word rule an ack that asked again would hold the question
 * open across days of unrelated conversation. The battle plan re-asks.
 */
export function readinessAnswerFacts(input: ReadinessAckInput): RegistrationNoteFacts {
  return {
    kind: 'readiness_answer',
    now: moment(input.now, input.timeZone),
    ready: input.ready,
    portal: input.portal.portalLabel,
    account: input.portal.accountLabel,
    who: whoPhrase(input.fitNotes),
  };
}

/**
 * Facts for the shortlist as the parent sees it in their approvals queue. The approval
 * unlocks the quiet-hours-exempt legs, so the facts enumerate the texts it causes: four
 * where Hale reads the town's portal and the readiness leg fires, three everywhere else.
 */
export function approvalCardFacts(
  shortlist: Shortlist,
  timeZone: string,
  now: Date,
  portal: SpotPortal | null,
): RegistrationNoteFacts {
  const opens = shortlist.opensForFamilyAt;
  // An unpublished band is a fact about the WINDOW, not about each child.
  const unpublished = shortlist.fitNotes.every((note) => note.fit === 'band_unknown');
  return {
    kind: 'approval_card',
    now: moment(now, timeZone),
    window: windowPhrase(shortlist),
    opensOn: writtenDate(opens, timeZone),
    opensAt: timeOfDay(opens, timeZone),
    link: shortlist.sourceUrl,
    residentsFirstDays: shortlist.isResidentWindow ? shortlist.residentPriorityDays : null,
    who: whoPhrase(shortlist.fitNotes),
    ageBand: unpublished
      ? { published: false }
      : {
          published: true,
          children: shortlist.fitNotes.map((note) => ({
            who: note.name ?? 'your teen',
            fit: note.fit === 'in_band' ? 'in_band' : 'near_band',
          })),
        },
    texts: [
      { text: 'week_ahead', daysBefore: HEADS_UP_LEAD_DAYS },
      ...(portal == null ? [] : [{ text: 'checklist' as const, daysBefore: READINESS_LEAD_DAYS }]),
      { text: 'evening_before' },
      { text: 'just_before_open', minutesBefore: GO_LEAD_MINUTES },
    ],
    courseLinkTip: portal != null,
  };
}
