import { asciiSpaces } from '~/lib/channel/intake/radar-decide';
import { townLabel } from '~/lib/channel/intake/radar-voice';
import { type OptOutForm, withOptOut } from '~/lib/channel/opt-out';
import { smsSegments } from '~/lib/channel/sms-segments';
import type { SpotPortal } from '~/lib/channel/spots/url';
import { formatWhenPhrase } from '~/lib/format/datetime';
import { dayKeyIn } from '~/lib/plan/spine';
import {
  type ApplicableClock,
  type CoursePage,
  type PrepVerdict,
  WINDOW_DRIFT_TOLERANCE_MINUTES,
  courseSignInUrl,
  priceClause,
} from './prepare.js';
import type { SequenceLeg, SequenceOptIn } from './schedule.js';
import type { FitNote, Shortlist } from './shortlist.js';

/**
 * VIL-242 · M7 — every sentence the sequence can send, rendered deterministically.
 *
 * NO MODEL RUNS IN THIS FILE, and unlike M4's nudge that is not a fallback path — it is
 * the whole design. Two reasons, and the second is the one that settles it:
 *
 *   1. There is nothing here for a model to add. Every leg is a time, a link and a list
 *      of names; the warmth a composer buys on a weekend suggestion is worth very little
 *      on "your registration opens in 15 minutes".
 *   2. These messages arrive at 6:15 a.m. through a QUIET-HOURS EXEMPTION the parent
 *      granted by approving a shortlist. A message with that privilege has to be one a
 *      human reviewed once and can predict forever. A generated sentence with a
 *      quiet-hours bypass is a sentence nobody approved waking a household for.
 *
 * Plain ASCII throughout: one typographic dash or curly apostrophe flips the whole SMS
 * to UCS-2 and halves the budget (see sms-segments.ts). The `asciiSpaces` wrapper exists
 * because Intl renders "6:30 a.m." with a NARROW NO-BREAK SPACE, which is not GSM-7.
 *
 * VIL-338 · THE PREPARED BRANCHES ARE FIXED TEMPLATES, NOT A CLAUSE BUDGET. Where a
 * course is bound, three legs compose from THAT tick's reading of the portal's own
 * page, and every one of them is a whole sentence chosen by a verdict rather than a
 * frame that drops adjectives until it fits. A composer that trims by length has an
 * output no test can enumerate, which on the one message that arrives fifteen minutes
 * before a registration opens is the same as having no test at all. So: one template
 * per verdict, every one of them measured in copy.test.ts against the LONGEST registry
 * host and prepare.ts's own PRINTABLE_STRING_CAPS, with the full CASL form.
 *
 * VIL-338 · THE THIRTEEN OTHER MUNICIPALITIES SEE NOTHING. Every branch below is
 * reached through `portal !== null`, and the non-portal sentences are the ones that
 * shipped, character for character — including "6:30 a.m.." in the go leg, a
 * pre-existing double period that is deliberately NOT fixed here because "byte
 * identical" is the property that makes this ticket safe to merge dark.
 *
 * VIL-484 · THE EVENING BATTLE PLAN IS NOT RENDERED HERE. The sentences that
 * named an open are facts (`battlePlanDecision`) for evening-compose.ts. The
 * model writes the whole text. A draft that cannot be written sends nothing.
 * That includes the page already open and a morning moved to another day: both
 * are situations in the facts, with no sentence built here.
 */

/**
 * Three segments on a portal leg, measured against the FULL CASL form.
 *
 * It is a deliberate budget change on a class that is capped for message COUNT and not
 * for segments: roughly one extra segment on three legs per registration window per
 * portal family. What it buys is the portal's own 288-character sign-in-and-return
 * link, which is the difference between a parent tapping once at 6:29 a.m. and a parent
 * hunting for a login. The thirteen municipalities with no readable portal keep
 * MAX_NUDGE_SEGMENTS.
 */
export const MAX_PORTAL_SEGMENTS = 3;

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
  waitlist?: { position: number | null; deadlineAt: Date | null };
}

export type CheckInReplyRender =
  | { outcome: 'registered' }
  | { outcome: 'waitlisted'; position: number | null; deadlineAt: Date | null }
  | { outcome: 'missed' }
  /** Nothing readable came back — the single gentle re-ask. */
  | { outcome: null };

export interface CheckInReplyInput {
  shortlist: Shortlist;
  timeZone: string;
  now: Date;
  reply: CheckInReplyRender;
}

/** The three answers the reply parser can actually read, quoted verbatim so a parent
 * who copies one back is guaranteed a match. */
const ANSWER_MENU = 'Reply "got in", "waitlisted #12" or "missed it".';

function when(instant: Date, timeZone: string, now: Date): string {
  return asciiSpaces(formatWhenPhrase(instant, timeZone, now));
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

/** Anything a handset would turn into a tappable link. Substring rather than parsed:
 * the question is not "is this a URL" but "will a phone make one of it". */
const LINK_SHAPED = /https?:\/\//i;

/**
 * The sentences this ladder may never say, and the reason each one is here: every one
 * of them claims Hale did something on the parent's account. Hale has no account, no
 * session and no credential anywhere in this feature, so each of these is a false
 * statement about the product's own behaviour — the class of lie a parent would only
 * discover at 6:31 a.m. with the seat gone.
 */
const FORBIDDEN_CLAIM = /filled in|staged|held for you|ready to go/i;

/**
 * The other half: sentences that state the parent's setup as a FACT rather than as
 * something the parent told Hale. Hale never logs in and never checks, so the only
 * honest form of this claim carries its own source — which is what `readinessClause`
 * exists to make structural, and this is the belt on it.
 */
const UNATTRIBUTED_READINESS = /your account is set|you(?:'re| are) (?:all )?ready|all set/i;

const READINESS_TOLD = 'You told me the setup is done.';
const READINESS_UNTOLD_EVENING =
  'You have not told me the setup is done - tonight is the time. Want me to know when it is?';

/**
 * The ONE sentence any leg may say about the parent's portal setup.
 *
 * Attribution is structural rather than reviewed: there are exactly three outputs, and
 * all three begin with what the PARENT did or did not say. Hale never verifies an
 * account, a child row, an address or a saved card — it cannot without logging in, and
 * it never will — so "your account is set" is not a shorter way of saying this, it is a
 * different and false claim. Null and false are the same sentence deliberately: silence
 * is not a no, but neither of them is a yes, and the copy owes the parent the same
 * nudge either way.
 */
export function readinessClause(ready: boolean | null): string {
  return ready === true ? READINESS_TOLD : READINESS_UNTOLD_EVENING;
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
 * plan for a parent who already answered YES prints `READINESS_TOLD`, which carries no
 * imperative either. Both still return true for that leg's key, which is why the source
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

export interface PreparedCopyContext {
  /** The one link this body carries, or null where it carries none. */
  url: string | null;
  /** Every page-derived string this body prints AS ITSELF. */
  printed: readonly string[];
  /** The tokens THIS tick's read proved. `printed` must be a subset. */
  backed: readonly string[];
  /** Retained so callers can still name a form. The footer is no longer appended
   * (founder decision, 2026-10-01), so a proactive body and a solicited reply are
   * measured as the same string. */
  optOut: OptOutForm | null;
}

/** Removes one literal occurrence, so a check runs on what is left over after the
 * pieces the body is allowed to carry are accounted for. */
function without(text: string, literal: string | null): string {
  if (literal === null || literal === '') return text;
  const at = text.indexOf(literal);
  return at < 0 ? text : `${text.slice(0, at)} ${text.slice(at + literal.length)}`;
}

/**
 * Everything wrong with a prepared body, named. Exported because the composers run it
 * on themselves and copy.test.ts runs it on their output: a gate only the composer can
 * reach is a gate nobody can test (VIL-337's spotOpenViolations, same reasoning).
 *
 * The two families it catches are different in kind and the composers treat them so. An
 * unbacked value or a forbidden claim is a LIE, and the composer falls back to the
 * variant of the same leg that prints no page value at all. A fourth segment is a COST,
 * and a body that is honest and long still beats no message on the morning the feature
 * exists for — so nothing here ever throws inside a leg.
 */
export function preparedCopyViolations(body: string, ctx: PreparedCopyContext): string[] {
  const violations: string[] = [];

  if (ctx.url === null) {
    if (LINK_SHAPED.test(body)) violations.push('unexpected_link');
  } else if (!body.includes(ctx.url)) {
    violations.push('url_missing');
  }
  if (ctx.printed.some((value) => !ctx.backed.includes(value))) violations.push('unbacked_value');

  // The link's own query string carries a `?`, so it is subtracted before the rule runs:
  // the question is whether HALE asked something, and every ask in this ladder is an
  // One question is the ask. A second is two answers Hale cannot tell apart.
  // The link's own query string is subtracted first, so its `?` is not Hale's.
  const questions = (without(body, ctx.url).match(/\?/g) ?? []).length;
  if (questions > 1) violations.push('asks_a_question');
  if (FORBIDDEN_CLAIM.test(body)) violations.push('forbidden_claim');
  if (UNATTRIBUTED_READINESS.test(body)) violations.push('unattributed_readiness');
  const wire = ctx.optOut === null ? body : withOptOut(body, ctx.optOut);
  if (smsSegments(wire) > MAX_PORTAL_SEGMENTS) violations.push('too_many_segments');
  return violations;
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

/**
 * The checklist, three days out. ONE ask (D14), and every item on it is the
 * municipality's own published prerequisite restated — an account, the child added with
 * their birthday, a complete address, a saved card. It claims nothing about Hale, and
 * it is the only leg whose whole purpose is a question, so the ask is the last thing in
 * it and it is imperative rather than interrogative.
 *
 * It carries the news the heads-up would have carried at this hour, because the leg was
 * CARVED OUT of that interval: a family matched three days before the open must still
 * learn what opens, when, and for whom.
 */
function readiness(input: LegCopyInput, portal: SpotPortal): string {
  const who = whoPhrase(input.shortlist.fitNotes);
  return `${windowPhrase(input.shortlist)} opens ${when(input.anchor, input.timeZone, input.now)} for ${who}. Before then, on ${portal.portalLabel}: ${portal.accountLabel}, ${who} added with their birthday(s), your address complete, and a card saved. Want me to know when that is done?`;
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

function checkIn(input: LegCopyInput): string {
  return `How did ${windowPhrase(input.shortlist)} go? ${ANSWER_MENU}`;
}

/**
 * The waitlist guards. Both say WHERE the clock came from, because it came from two
 * places a parent should be able to separate: the response window is the
 * municipality's published rule, and the start is the parent's own message. Hale never
 * sees the offer email, so claiming to know when the offer landed would be a guess
 * dressed as a deadline.
 */
function waitlistGuard(input: LegCopyInput, leg: 'waitlist_half' | 'waitlist_final'): string {
  const hours = input.shortlist.waitlistResponseHours;
  const deadline = input.waitlist?.deadlineAt ?? null;
  const town = townLabel(input.shortlist.windowRef.municipality);
  if (hours === null || deadline === null) {
    // The scheduler never emits a guard without a clock; this keeps the renderer total
    // rather than throwing inside a send path.
    return `Checking in on your ${town} waitlist spot - watch your email for an offer.`;
  }
  const until = `${when(deadline, input.timeZone, input.now)}`;
  if (leg === 'waitlist_final') {
    return `About 2h left to answer a ${town} waitlist offer: ${hours}h from your message runs out ${until}. Check your email and portal.`;
  }
  return `Halfway on the ${town} waitlist clock. Their window is ${hours}h from your message, so it runs out ${until}.`;
}

/** One leg's SMS body, without the opt-out — the sender appends that exactly once. */
export function renderSequenceLeg(leg: SequenceLeg, input: LegCopyInput): string {
  switch (leg) {
    case 'heads_up':
      throw new Error('registration sequence: the heads-up text is composed from facts');
    case 'readiness':
      // `dueLeg` never routes a portal-less sequence here. The runner composes the
      // heads-up from facts for that case before it would reach this renderer.
      if (input.portal == null) {
        throw new Error('registration sequence: the heads-up text is composed from facts');
      }
      return readiness(input, input.portal);
    case 'battle_plan': {
      throw new Error('registration sequence: the evening text is composed from facts');
    }
    case 'go':
      throw new Error('registration sequence: the morning-of text is composed from facts');
    case 'check_in':
      return checkIn(input);
    case 'waitlist_half':
    case 'waitlist_final':
      return waitlistGuard(input, leg);
  }
}

/** Hale's answer to what the parent reported. Solicited, so no opt-out line. */
export function renderCheckInReply(input: CheckInReplyInput): string {
  const { shortlist, reply } = input;
  const town = townLabel(shortlist.windowRef.municipality);
  if (reply.outcome === 'registered') {
    return `That's a spot - you're in for ${town} ${shortlist.windowRef.cycleLabel}.`;
  }
  if (reply.outcome === 'missed') {
    return `Sorry - that one filled. I'll flag the next ${town} window early.`;
  }
  if (reply.outcome === null) {
    return `Sorry, I didn't catch that. ${ANSWER_MENU}`;
  }
  const spot = reply.position === null ? 'Waitlisted' : `Waitlisted #${reply.position}`;
  if (shortlist.waitlistResponseHours === null || reply.deadlineAt === null) {
    return `${spot}, noted. ${town} has no published response window, so I can't set a clock - watch your email closely.`;
  }
  return `${spot}, noted. ${town} gives ${shortlist.waitlistResponseHours}h to answer an offer, so I'll nudge you before ${when(reply.deadlineAt, input.timeZone, input.now)}.`;
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
 * The answer to a parent who just sent a course link — the one moment in this feature
 * where Hale states precisely what it read, and it has room because it is SOLICITED: no
 * CASL line, no proactive gate, no leg slot, no dedupe key.
 *
 * Every clause is present or absent BY FACT, never by phrasing: a value the bytes did
 * not back is not printed, a price the page does not name as a clean pair or a single
 * row is omitted entirely, and the M1 disagreement is named only when there is one. It
 * asks nothing — it is the answer to a question the parent asked by pasting.
 *
 * THE ONE LENGTH RULE, and it is a fixed pair rather than a budget: at prepare.ts's
 * caps a page could publish a 60-character name, a 40-character band and two
 * 16-character figures, which is a fourth segment. Past three segments the two clauses
 * a parent can read off the page for themselves — the price and the barcode — come out
 * together, and what survives is what they cannot get any other way: what it is, when
 * it opens, that Hale's own dates disagreed, and the two things it cannot pre-do.
 *
 * THE TRIMMED FORM IS RETURNED UNGATED, and that is the decision rather than an
 * oversight: it is the last form there is, and re-gating it would only leave the
 * function with nothing to return. Every clause left in it scales with nothing except
 * the number of children, so a five-child household at every cap with both warnings
 * measures a FOURTH segment (pinned in copy.test.ts). On a solicited reply that carries
 * no CASL footer and no dedupe key that is a cost, not a lie — the module's own
 * distinction — and every other rule the gate enforces still holds on it.
 */
export function renderCourseBindAck(input: CourseBindAckInput): string {
  const full = bindAck(input, true);
  return preparedCopyViolations(full, bindAckContext(input, true)).length === 0
    ? full
    : bindAck(input, false);
}

/** The page values a given form of the ack prints, so the gate checks the body Hale
 * actually composed rather than a list somebody kept in step by hand. */
function bindAckValues(input: CourseBindAckInput, decorated: boolean): string[] {
  const { facts, backed } = input.page;
  const values = [
    printable(facts.EventName, backed),
    printable(facts.StartDay, backed),
    printable(facts.StartTime, backed),
    input.page.age.fit === 'unknown' ? null : printable(facts.AgeRestrictions, backed),
  ];
  if (decorated) {
    values.push(printable(facts.CourseId, backed));
    for (const row of facts.Prices ?? []) values.push(printable(row.DisplayAmount, backed));
  }
  return values.filter((value): value is string => value !== null);
}

function bindAckContext(input: CourseBindAckInput, decorated: boolean): PreparedCopyContext {
  return {
    // A solicited ack carries no link: the parent just sent one, and a second link in
    // the reply is a link nobody asked for.
    url: null,
    printed: bindAckValues(input, decorated),
    backed: input.page.backed,
    optOut: null,
  };
}

function bindAck(input: CourseBindAckInput, decorated: boolean): string {
  const { page, portal, timeZone, now } = input;
  const { facts, backed } = page;
  const name = printable(facts.EventName, backed);
  const day = printable(facts.StartDay, backed);
  const time = printable(facts.StartTime, backed);
  const schedule = day !== null && time !== null ? `, ${day} ${time}` : '';
  const parts: string[] = [
    `${input.replaced ? 'Swapped. ' : ''}${portal.portalLabel}: ${name ?? 'that course'}${schedule}.`,
  ];

  const band = printable(facts.AgeRestrictions, backed);
  const fit = fitPhrase(page, input.fitNotes);
  if (band !== null && fit !== null) parts.push(`Ages ${band} - ${fit}.`);

  if (decorated) {
    const price = priceClause(facts.Prices);
    if (price !== null) parts.push(`${price}.`);
    // The human barcode Markham's phone-registration line asks for, days early and with
    // room to write it down. No phone number is printed: registration_windows holds none.
    const barcode = printable(facts.CourseId, backed);
    if (barcode !== null) parts.push(`Course ${barcode}.`);
  }

  const residents = page.clocks.residents;
  const alsoResidents =
    residents !== null && input.clock.name === 'public date'
      ? `, residents ${dateOnly(residents, timeZone)}`
      : '';
  parts.push(
    `Opens ${when(input.clock.at, timeZone, now)} - the ${input.clock.name}${alsoResidents}.`,
  );

  // The M1 row is a hand-read of a municipal info page and the course page is the
  // software that will open the door. Where they disagree the parent is told, in both
  // dates — a silent correction is the one thing a hand-verified dataset may not get.
  const drift = Math.abs(input.clock.at.getTime() - input.opensForFamilyAt.getTime()) / 60_000;
  if (drift > WINDOW_DRIFT_TOLERANCE_MINUTES) {
    parts.push(
      `My ${townLabel(input.municipality)} dates said ${when(input.opensForFamilyAt, timeZone, now)} I am going by the page.`,
    );
  }

  // The two things the checklist cannot ask for, because the parent cannot pre-do them:
  // a questionnaire Hale has never seen and holds no source for, and a prerequisite
  // level the portal will check at checkout.
  const form = facts.RegFormId != null;
  const prerequisite = facts.PrerequisiteEvents === true;
  if (form || prerequisite) {
    const listed = form
      ? `a form I cannot see${prerequisite ? ' and a prerequisite level' : ''}`
      : 'a prerequisite level';
    parts.push(`It lists ${listed} - leave time.`);
  }
  return parts.join(' ');
}

/** How the page's band sits against the birthdays Hale holds, in the ack's words, or
 * nothing where the three instants disagreed or the DOB was derived. */
function fitPhrase(page: CoursePage, fitNotes: readonly FitNote[]): string | null {
  const who = whoPhrase(fitNotes);
  const many = fitNotes.length > 1;
  const held = many ? 'the birthdays I hold' : 'the birthday I hold';
  if (page.age.fit === 'in_band') return `${who} ${many ? 'fit' : 'fits'} on ${held}`;
  if (page.age.fit === 'outside_band')
    return `${who} ${many ? 'are' : 'is'} outside that on ${held}`;
  return null;
}

export interface ReadinessAckInput {
  portal: SpotPortal;
  /** What the parent just said. */
  ready: boolean;
  fitNotes: readonly FitNote[];
}

/**
 * The answer to a bare YES or NO on the checklist. Solicited, so no opt-out line.
 *
 * The NO deliberately does NOT re-ask. Under the last-word rule the question is open
 * only while the ask is Hale's most recent outbound message, so an ack that asked again
 * would hold the question open across days of unrelated conversation and claim a "yes"
 * that answered something else. The battle plan re-asks, once, the evening before.
 */
export function renderReadinessAck(input: ReadinessAckInput): string {
  if (input.ready) {
    return `You told me the setup on ${input.portal.portalLabel} is done.`;
  }
  return `No problem. The four: ${input.portal.accountLabel}, ${whoPhrase(input.fitNotes)} added with their birthday(s), address complete, a card saved. I will ask again the evening before.`;
}

/**
 * THE SECOND PARENT'S YES, to a card the household has already approved.
 *
 * The heads-up ends "Want me to run the morning with you?" and now reaches both
 * numbers, so one of the two answers arrives at an approvals queue the other parent has
 * already emptied. Before this sentence existed that turn fell through to the coach,
 * whose thread still ended in that ask and which knows nothing about the partner's
 * approval — the one shape of turn where a model is most likely to invent a
 * confirmation (audit 2026-09-17 r1).
 *
 * It states the household's state and asks nothing: the ladder is already running, and
 * a second consent for one registration morning is not a thing to collect. Tense-free
 * on purpose, because the same sentence has to be true whether the plan leg has gone
 * out yet or not.
 */
export const SHORTLIST_ALREADY_APPROVED_ACK =
  "That is already a yes - I have this one, and I'll run the morning with you.";

const CONSENT_THREE_TEXTS =
  'Approving this asks me to text you a week ahead, the evening before, and 15 minutes before it opens. I never register for you.';

const CONSENT_FOUR_TEXTS =
  'Approving this asks me to text you a week ahead, a checklist a few days out, the evening before, and 15 minutes before it opens. I never register for you.';

/**
 * The shortlist as the parent sees it in their approvals queue. Longer than an SMS
 * because it is read on a screen and it is the thing being consented to — the approval
 * is what unlocks the two quiet-hours-exempt legs, so it has to state plainly what it
 * will cause.
 */
export function renderShortlistRationale(
  shortlist: Shortlist,
  timeZone: string,
  now: Date,
  portal: SpotPortal | null,
): string {
  const lines = [
    `${windowPhrase(shortlist)} registration opens ${when(shortlist.opensForFamilyAt, timeZone, now)}.`,
    `Register here: ${shortlist.sourceUrl}`,
  ];
  if (shortlist.isResidentWindow && shortlist.residentPriorityDays !== null) {
    lines.push(
      `Your postal code gets the residents-first date, ${shortlist.residentPriorityDays} day${shortlist.residentPriorityDays === 1 ? '' : 's'} ahead of the general open.`,
    );
  }
  // An unpublished band is a fact about the WINDOW, not about each child, so it is
  // one line naming everyone rather than the same sentence repeated per child. Saying
  // "inside the published age band" here would assert a band the municipality never
  // printed — Burlington publishes none on any of its rows.
  if (shortlist.fitNotes.every((note) => note.fit === 'band_unknown')) {
    lines.push(
      `${townLabel(shortlist.windowRef.municipality)} does not publish an age band for this one, so check it fits ${whoPhrase(shortlist.fitNotes)}.`,
    );
  } else {
    for (const note of shortlist.fitNotes) {
      const who = note.name ?? 'Your teen';
      lines.push(
        note.fit === 'in_band'
          ? `${who} is inside the published age band.`
          : `${who} is just outside the published age band, within the margin on an approximate birthday.`,
      );
    }
  }
  // THE SENTENCE THE APPROVAL CONSENTS TO, and it enumerates the messages — so a
  // household whose town has a readable portal is told about the checklist BEFORE it
  // arrives, and the thirteen others read the sentence that shipped, byte for byte.
  // "I never register for you" is verbatim on both, and stays that way: it is asserted
  // in the toddler journey and mirrored in the capability table's CANNOT row.
  lines.push(portal == null ? CONSENT_THREE_TEXTS : CONSENT_FOUR_TEXTS);
  if (portal != null) {
    // The one place a parent learns how to bind a course, and it belongs here rather
    // than in an SMS leg: this is read on a screen, where a longer sentence fits, and
    // no leg may carry a second reply-able ask (D14).
    lines.push(
      'If you send me the link to the course page once you have picked one, the morning text will carry it.',
    );
  }
  return lines.join('\n');
}
