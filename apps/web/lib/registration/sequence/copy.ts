import { asciiSpaces } from '~/lib/channel/intake/radar-decide';
import { townLabel } from '~/lib/channel/intake/radar-voice';
import { type OptOutForm, withOptOut } from '~/lib/channel/opt-out';
import { isGsm7, smsSegments } from '~/lib/channel/sms-segments';
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
  'You have not told me the setup is done - tonight is the time. Reply YES when it is.';
const READINESS_UNTOLD_MORNING =
  'You have not told me the setup is done - sign in now and check it.';

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
export function readinessClause(ready: boolean | null, at: 'evening' | 'morning'): string {
  if (ready === true) return READINESS_TOLD;
  return at === 'evening' ? READINESS_UNTOLD_EVENING : READINESS_UNTOLD_MORNING;
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
  /** The CASL form this body will ship under, or null for a solicited reply that never
   * carries one. A budget measured against a footer the message cannot have is a
   * budget about a different message. */
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
  // imperative ("Reply YES when that is done") precisely so this rule can be absolute.
  if (without(body, ctx.url).includes('?')) violations.push('asks_a_question');
  if (FORBIDDEN_CLAIM.test(body)) violations.push('forbidden_claim');
  if (UNATTRIBUTED_READINESS.test(body)) violations.push('unattributed_readiness');
  if (!isGsm7(body)) violations.push('not_gsm7');
  const wire = ctx.optOut === null ? body : withOptOut(body, ctx.optOut);
  if (smsSegments(wire) > MAX_PORTAL_SEGMENTS) violations.push('too_many_segments');
  return violations;
}

/** The preferred body, or the one that prints no page value, on any violation. */
function guarded(preferred: string, fallback: string, ctx: PreparedCopyContext): string {
  return preparedCopyViolations(preferred, ctx).length === 0 ? preferred : fallback;
}

/** A page string Hale may print, or null. The reader has already dropped anything the
 * bytes did not back or a phone could not carry; this is the composer refusing to
 * print what it was not handed. */
function printable(value: string | null | undefined, backed: readonly string[]): string | null {
  if (typeof value !== 'string') return null;
  return backed.includes(value) ? value : null;
}

/** "The birthday I hold is" / "The birthdays I hold are" — the subject of every
 * sentence about the page's age band, because the birthday is the only thing Hale has
 * and the sentence should say so. */
function birthdaysHeld(count: number): string {
  return count === 1 ? 'The birthday I hold is' : 'The birthdays I hold are';
}

function headsUp(input: LegCopyInput): string {
  const { shortlist } = input;
  const who = whoPhrase(shortlist.fitNotes);
  const resident =
    shortlist.isResidentWindow && shortlist.residentPriorityDays !== null
      ? ' Your postal code gets the residents-first date.'
      : '';
  // The hedge is load-bearing: the match may rest on the +/-6-month tolerance the
  // matcher grants a DOB derived from a spoken age, so asserting the band would be
  // asserting something Hale does not know.
  const hedge = shortlist.ageApproximate ? " Worth a look if that's still their band." : '';
  // The unapproved household's shortlist is an ordinary drafted_for_approval row, so the
  // YES that approves it is the same one the app button sends (router/wiring.ts binds
  // both to approveDraftedAction). Pointing them at the app would ask them to learn a
  // second surface to do what the thread they are already in can do.
  const cta = headsUpPromisesPlan(input.optIn)
    ? " I'll send your plan the evening before."
    : " Reply YES and I'll run the morning with you.";
  return `${windowPhrase(shortlist)} registration opens ${when(shortlist.opensForFamilyAt, input.timeZone, input.now)} for ${who}.${resident}${hedge}${cta}`;
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
  return `${windowPhrase(input.shortlist)} opens ${when(input.anchor, input.timeZone, input.now)} for ${who}. Before then, on ${portal.portalLabel}: ${portal.accountLabel}, ${who} added with their birthday(s), your address complete, and a card saved. Reply YES when that is done, or NO if not.`;
}

function battlePlan(input: LegCopyInput): string {
  const { shortlist } = input;
  // Nullish for the reason schedule.ts's `hasReadablePortal` is: an absent portal keeps
  // the sentence that shipped, which is inert, rather than composing one about a portal
  // nobody looked up.
  const portal = input.portal ?? null;
  // THE ANCHOR, never the M1 row. For an unbound ladder the two are the same instant by
  // construction, so this is byte-identical for the thirteen municipalities and for
  // every household that has pasted nothing; for a bound one the row is a hand-read of
  // an info page (Markham's carries only the resident clock, Oakville's non-resident
  // open is a midnight placeholder) and reaching for it here would schedule the leg on
  // one morning and name another.
  const municipal = `Tomorrow: ${windowPhrase(shortlist)} opens ${timeOfDay(input.anchor, input.timeZone)} for ${whoPhrase(shortlist.fitNotes)}. Sign in tonight and have this open: ${shortlist.sourceUrl}`;
  if (portal === null) return municipal;
  const prepared =
    input.prep === null ? null : battlePlanPrepared(input, input.prep, portal, municipal);
  // No course bound: the municipal page is still the right link, and the one thing this
  // household has that the other thirteen do not is a checklist they were asked about.
  return prepared ?? `${municipal} ${readinessClause(input.readinessReady, 'evening')}`;
}

/**
 * The evening-before plan for a household whose course Hale can read, composed from
 * THIS tick's bytes. Null where the stored URL will not mint a sign-in link — a URL
 * `courseSignInUrl` refuses is a URL this composer will not treat as a bound course,
 * and the caller falls back to the municipal sentence.
 */
function battlePlanPrepared(
  input: LegCopyInput,
  prep: PrepCopyInput,
  portal: SpotPortal,
  municipal: string,
): string | null {
  const link = courseSignInUrl(prep.courseUrl);
  if (link === null) return null;
  const label = portal.portalLabel;
  const clause = readinessClause(input.readinessReady, 'evening');
  const verdict = prep.verdict;
  const openAt = (at: Date) => timeOfDay(at, input.timeZone);

  switch (verdict.kind) {
    case 'page_unreadable':
      // It does NOT wait for a better read: the go leg re-reads in the morning anyway,
      // and a plan at 06:10 is worse than a plan without the course clause.
      return `Tomorrow: ${label} opens ${openAt(input.anchor)} I could not re-read the course page tonight, so check it yourself: ${prep.courseUrl} ${clause}`;
    case 'course_gone':
      return `${municipal} The course page you sent me is gone from ${label}.`;
    case 'registration_closed':
      return `${municipal} ${label} shows registration closed, so this is the general link.`;
    case 'late_by_drift': {
      const clock = verdict.clock;
      if (clock === null) return `${municipal} ${clause}`;
      return `Heads up: ${label} shows this course already open since ${when(clock.at, input.timeZone, input.now)} Sign in, then Register: ${link}`;
    }
    case 'age_ineligible':
      return ageSentence(
        verdict,
        input,
        label,
        prep.courseUrl,
        // The evening-before leg says when the morning is on every other branch, and a
        // parent whose child may be out of band still has to decide by that clock.
        `Opens ${openAt(input.anchor)} Sign in and check: ${prep.courseUrl}`,
        'Tomorrow: ',
      );
    case 'window_moved': {
      const clock = verdict.clock;
      if (clock === null) return `${municipal} ${clause}`;
      // A move INSIDE tomorrow is not news: run.ts has just refreshed the anchor, so the
      // ordinary plan prints the new time and is true. A move to another DAY is news,
      // and it is the only battle plan that says so — the key is spent, so there is no
      // second "Tomorrow:" the evening before the new morning.
      if (dayKeyIn(clock.at, input.timeZone) !== dayKeyIn(input.anchor, input.timeZone)) {
        const name = printable(verdict.facts.EventName, verdict.backed);
        const moved = `Heads up: ${label} now shows ${name} opening ${when(clock.at, input.timeZone, input.now)} That is not tomorrow, so I have moved your morning to it. ${prep.courseUrl}`;
        const unnamed = `Heads up: ${label} now shows that course opening ${when(clock.at, input.timeZone, input.now)} That is not tomorrow, so I have moved your morning to it. ${prep.courseUrl}`;
        if (name === null) return unnamed;
        return guarded(moved, unnamed, {
          url: prep.courseUrl,
          printed: [name],
          backed: verdict.backed,
          optOut: 'full',
        });
      }
      return plannedCourse(verdict, prep, label, openAt(clock.at), clause);
    }
    case 'prepared':
      // The ANCHOR, not this read's clock. `prepared` is the verdict for a page that
      // AGREES with the anchor within WINDOW_DRIFT_TOLERANCE_MINUTES, so printing the
      // page's own instant here would put up to fifteen minutes between this sentence
      // and the go leg's on the same course, for no gain — a page that really moved
      // returns `window_moved`, which refreshes the anchor and prints the new time.
      return plannedCourse(verdict, prep, label, openAt(input.anchor), clause);
  }
}

/** The evening plan for a course that reads clean: its name where the bytes back one,
 * the portal's own page, and the one clause about what the parent told Hale. */
function plannedCourse(
  page: CoursePage,
  prep: PrepCopyInput,
  label: string,
  at: string,
  clause: string,
): string {
  const name = printable(page.facts.EventName, page.backed);
  const unnamed = `Tomorrow: ${label} opens ${at} Sign in tonight and have this open: ${prep.courseUrl} ${clause}`;
  if (name === null) return unnamed;
  return guarded(
    `Tomorrow: ${name} at ${label} opens ${at} Sign in tonight and have this open: ${prep.courseUrl} ${clause}`,
    unnamed,
    { url: prep.courseUrl, printed: [name], backed: page.backed, optOut: 'full' },
  );
}

/**
 * The one sentence a leg may send about a child the page's own band excludes.
 *
 * It prints the band VERBATIM beside the verdict so a parent can catch a wrong reading
 * in the sentence that makes it, and it names no child: the verdict is unanimous across
 * every matched child by construction, the family already knows whose morning this is,
 * and a sentence with no name cannot get rule #1 wrong. Where the page publishes no
 * band string there is nothing to quote and the sentence says only what Hale computed.
 */
function ageSentence(
  page: CoursePage,
  input: LegCopyInput,
  label: string,
  url: string,
  tail: string,
  lead = '',
): string {
  const band = printable(page.facts.AgeRestrictions, page.backed);
  const held = birthdaysHeld(input.shortlist.fitNotes.length);
  const unbanded = `${lead}${held} outside the age band ${label} lists for that course. ${tail}`;
  if (band === null) return unbanded;
  return guarded(
    `${lead}${label} lists that course as ages ${band}. ${held} outside that. ${tail}`,
    unbanded,
    { url, printed: [band], backed: page.backed, optOut: 'full' },
  );
}

function go(input: LegCopyInput): string {
  const { shortlist } = input;
  const portal = input.portal ?? null;
  // The anchor, for the same reason the battle plan uses it — and byte-identical for
  // every unbound ladder, which is the only kind the non-portal municipalities have.
  const municipal = `${windowPhrase(shortlist)} opens ${timeOfDay(input.anchor, input.timeZone)}. Your link: ${shortlist.sourceUrl}`;
  if (portal === null) return municipal;
  const prepared = input.prep === null ? null : goPrepared(input, input.prep, portal);
  return prepared ?? `${municipal} ${readinessClause(input.readinessReady, 'morning')}`;
}

/**
 * The flagship, fifteen minutes out, composed from THIS tick's read and carrying the
 * portal's own sign-in-and-return link.
 *
 * THE LINK AND THE TIME ARE ROW-BACKED, so the leg never defers: it sends at the first
 * tick inside its interval whatever the read gave, and the read only decides WHICH
 * truthful sentence goes. A deferral would turn a fifteen-minute interval with three
 * cron ticks in it back into an instant.
 */
function goPrepared(input: LegCopyInput, prep: PrepCopyInput, portal: SpotPortal): string | null {
  const link = courseSignInUrl(prep.courseUrl);
  if (link === null) return null;
  const label = portal.portalLabel;
  const at = timeOfDay(input.anchor, input.timeZone);
  const verdict = prep.verdict;
  /** Only what the sequence row already knew. The answer for a verdict that cannot
   * reach here, so an unreachable shape costs a shorter sentence and never a throw. */
  const bare = `${label} opens ${at} Sign in, then Register: ${link}`;

  switch (verdict.kind) {
    case 'prepared': {
      const clause = readinessClause(input.readinessReady, 'morning');
      const tail = input.readinessReady === true ? 'Sign in, then Register: ' : 'Then Register: ';
      return `${label} opens ${at} ${clause} ${tail}${link}`;
    }
    case 'page_unreadable':
      // False-safe: it says nothing at all about the course, and the link is never
      // withheld because Hale had a bad fetch.
      return `I could not read ${label} just now, so I cannot tell you what it says. It opens ${at} Sign in, then Register: ${link}`;
    case 'course_gone':
      return `${label} is not showing the course you sent me. Registration still opens ${at} Check the page yourself: ${prep.courseUrl}`;
    case 'registration_closed':
      return `${label} shows that course as closed to online registration. Nothing changed on my side - check the page: ${prep.courseUrl}`;
    case 'age_ineligible':
      return ageSentence(verdict, input, label, link, `Opens ${at} ${link}`);
    case 'window_moved': {
      const clock = verdict.clock;
      if (clock === null) return bare;
      return `Heads up: I had ${at} for this and ${label} now shows ${when(clock.at, input.timeZone, input.now)} Go by the page: ${link}`;
    }
    case 'late_by_drift': {
      const clock = verdict.clock;
      if (clock === null) return bare;
      // The word "opens" never appears in a text sent after the page's own open.
      return `Heads up: ${label} now shows this opened at ${when(clock.at, input.timeZone, input.now)} Sign in, then Register: ${link}`;
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
      return headsUp(input);
    case 'readiness':
      // `dueLeg` never routes a portal-less sequence here; the renderer stays total
      // anyway, because a throw in a leg costs that family its whole tick, and the
      // heads-up is exactly what the scheduler would have chosen instead.
      return input.portal == null ? headsUp(input) : readiness(input, input.portal);
    case 'battle_plan':
      return battlePlan(input);
    case 'go':
      return go(input);
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
    return `That's a spot. Noted: ${town} ${shortlist.windowRef.cycleLabel} registered.`;
  }
  if (reply.outcome === 'missed') {
    return `Sorry - that one filled. Noted, and I'll flag the next ${town} window early.`;
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
    return `Noted - you told me the setup on ${input.portal.portalLabel} is done.`;
  }
  return `No problem. The four: ${input.portal.accountLabel}, ${whoPhrase(input.fitNotes)} added with their birthday(s), address complete, a card saved. I will ask again the evening before.`;
}

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
      `Your postal code gets the residents-first date, ${shortlist.residentPriorityDays} days ahead of the general open.`,
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
