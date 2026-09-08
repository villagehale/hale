import { type Database, type RegistrationWindow, schema } from '@hale/db';
import { ageInMonths } from '@hale/types';
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { readWindows as readRegistrationWindows } from '~/lib/channel/intake/radar';
import type { ChannelTransport } from '~/lib/channel/intake/transport';
import { type SpotPortal, portalForMunicipality } from '~/lib/channel/spots/url';
import { createTwilioTransport } from '~/lib/channel/twilio/transport';
import { type AcceptedStatus, acceptedStatus, dedupeActive } from '~/lib/channel/ledger';
import { fulfillCommitment, recordCommitment } from '~/lib/commitments/ledger';
import { f14Allowlist, f14Enabled } from '~/lib/channel/nudge/run';
import { withOptOut } from '~/lib/channel/opt-out';
import { refuseUnbackedSend } from '~/lib/channel/reconcile/gate';
import {
  type OutboundGatePorts,
  type ProactiveHoldReason,
  assertProactiveSendAllowed,
  buildOutboundGatePorts,
} from '~/lib/channel/outbound-gate';
import { threadProactiveMessage } from '~/lib/channel/thread';
import { resolveSendablePhone } from '~/lib/channels/sms-consent-core';
import { draftInlineAction } from '~/lib/coach/inline-action';
import { localParts } from '~/lib/loop/prefs';
import { pipelineClient } from '~/lib/pipeline/client';
import {
  type RegistrationMatch,
  matchRegistrationWindows,
  resolveFamilyOpen,
} from '~/lib/registration/match-registration-windows';
import { type FetchPage, createFetchBody, pageCache } from '~/lib/registration/verify-sweep';
import { loadClaimedWindowIds } from './claims.js';
import {
  headsUpPromisesPlan,
  renderSequenceLeg,
  renderShortlistRationale,
  windowPhrase,
} from './copy.js';
import {
  GO_FETCH_TIMEOUT_MS,
  type PrepInput,
  type PrepVerdict,
  READ_WALL_BUDGET_MS,
  readCoursePrep,
} from './prepare.js';
import {
  HEADS_UP_MINUTE_LOCAL,
  type RegistrationOutcome,
  type SequenceLeg,
  type SequenceOptIn,
  dueLeg,
  legIsUrgent,
  openLegWindows,
  waitlistDeadline,
} from './schedule.js';
import {
  type SequenceChild,
  type Shortlist,
  buildShortlist,
  windowShortlist,
} from './shortlist.js';

/**
 * VIL-242 · M7 — the registration ladder, swept every five minutes.
 *
 * The job M4 could not do. M4 says "Toronto opens Tuesday" once and leaves; this takes
 * the morning over: it prepares a shortlist days ahead and holds it for approval, warns
 * a week out, hands over a plan the evening before, taps the parent fifteen minutes
 * before the doors open, and then guards the waitlist clock afterwards. It never
 * registers for anyone (D8) — there is no credentialed submission and no CAPTCHA path
 * anywhere in this module, and the shortlist's action type has no executor that could
 * grow one.
 *
 * TWO PHASES, and they are separate because they have different costs and cadences:
 *
 *   A. PROPOSE — once a day, in the family's own mid-morning slot, look for a matched
 *      window inside the lead horizon and, if there is one, CLAIM it and draft the
 *      shortlist for approval. The claim is minted FIRST, on a unique index, so two
 *      overlapping ticks cannot produce two approval cards for one window.
 *   B. RUN THE LEGS — every tick, for every live sequence. Which leg is due is a pure
 *      function of the LIVE window row (see schedule.ts), so a municipality that moves
 *      its date re-anchors the entire ladder with no reconciliation: there is nothing
 *      materialized to be stale.
 *
 * FIVE MINUTES, not an hour. The go leg exists in a fifteen-minute window that must
 * never be crossed — an hourly cron would hit it one time in four, and the one message
 * this whole feature is built around would usually not arrive. Every other leg has an
 * interval hours or days wide, so the extra ticks cost one narrow indexed read.
 *
 * Everything unprompted goes through the F14 outbound gate. This class is uncapped and
 * its two urgent legs may cross quiet hours — both exemptions are the gate's, granted to
 * the class, and both are earned by the parent's approval of the shortlist.
 *
 * Dark by default (D21): the sweep is a no-op unless the shared F14 flag or allowlist
 * arms it, exactly as M4's is.
 */

/**
 * How far ahead of a window the shortlist is drafted. Three days of slack before the
 * heads-up leg at T-7d: long enough that a parent who checks Hale twice a week still
 * approves in time to get the full ladder, short enough that the approvals queue is not
 * full of dates nobody can act on yet.
 */
export const SHORTLIST_LEAD_DAYS = 10;

/** Filter first, then cap — a cap-then-filter would starve every family past the
 * oldest N of their slot forever. */
const MAX_SEQUENCE_FAMILIES_PER_RUN = 100;

/**
 * Whether `now` sits in this family's daily shortlist slot. The same mid-morning hour
 * the heads-up leg lands in, matched as a whole HOUR: an exact-minute match would drop
 * every family whose cron tick ran a minute late.
 */
export function isShortlistSlot(now: Date, timeZone: string): boolean {
  return (
    Math.floor(localParts(now, timeZone).minutes / 60) === Math.floor(HEADS_UP_MINUTE_LOCAL / 60)
  );
}

export interface SequenceFamily {
  familyId: string;
  parentUserId: string;
  /** The FSA, never the full postal code (rule #1). Null when the family has no area. */
  areaCoarse: string | null;
  timeZone: string;
}

/** A sequence the sweep may still have something to do about. */
export interface LiveSequence {
  sequenceId: string;
  familyId: string;
  parentUserId: string;
  timeZone: string;
  /** The family's FSA, read LIVE. It is what decides whether this household registers
   * on the resident date or the general one — and therefore what the whole ladder is
   * anchored on, so it is resolved at send time rather than frozen at proposal. */
  areaCoarse: string | null;
  /** The LIVE M1 row. Every leg time is derived from it at send time, so a corrected
   * date moves the whole ladder. */
  window: RegistrationWindow;
  /** Read live off the approval spine — see registration-sequences.ts. */
  optIn: SequenceOptIn;
  outcome: RegistrationOutcome | null;
  waitlistPosition: number | null;
  waitlistStartedAt: Date | null;
  /** VIL-338 · the course page the parent pasted, exactly as `sanitizeSpotUrl` rebuilt
   * it, or null while nothing is bound. Non-null is what turns the two send-time reads
   * on — it is the whole switch between the ladder that shipped and the prepared one. */
  courseUrl: string | null;
  /** THE ANCHOR when a course is bound: the instant that page says it opens for THIS
   * family. Every interval and every sentence is derived from it, so a bind that moves
   * the morning moves the ladder. Null and non-null together with `courseUrl` — the
   * row's own CHECK constraint. */
  courseOpensAt: Date | null;
  /** What the parent TOLD Hale about their portal setup. Never inferred, never
   * verified; null is "unasked or unanswered", which the copy says in those words. */
  readinessReady: boolean | null;
}

export interface SequenceLedgerWrite {
  familyId: string;
  parentUserId: string;
  channel: 'sms';
  category: 'registration_sequence';
  templateKey: string;
  dedupeKey: string;
  status: AcceptedStatus;
  providerMessageId: string;
  sentAt: Date;
}

export interface SequenceAuditRow {
  familyId: string;
  actor: string;
  actionTaken: string;
  targetTable: string;
  targetId: string;
  after: Record<string, unknown>;
}

export interface SequenceRunDeps {
  selectFamilies(database: Database, now: Date): Promise<SequenceFamily[]>;
  loadChildren(database: Database, familyId: string): Promise<SequenceChild[]>;
  loadWindows(database: Database, areaCoarse: string): Promise<RegistrationWindow[]>;
  loadClaimedWindowIds(database: Database, familyId: string): Promise<Set<string>>;
  /** Insert the claim, or return null when this family already has one for the window
   * (the unique index rejected it). The atomic step a double tick races on. */
  claimWindow(
    database: Database,
    input: { familyId: string; windowId: string; parentUserId: string },
  ): Promise<string | null>;
  /** Draft the shortlist through the approval spine. Returns the action id. */
  draftShortlist(
    database: Database,
    input: {
      familyId: string;
      actorUserId: string;
      childId: null;
      intentKind: string;
      rationale: string;
      /** The card's heading — what opens, where. */
      title: string;
      /** The municipal page. The one link the whole sequence points at. */
      sourceUrl: string;
    },
  ): Promise<string>;
  attachAction(database: Database, sequenceId: string, actionId: string): Promise<void>;
  /** Undo a claim whose shortlist could not be drafted. */
  releaseClaim(database: Database, sequenceId: string): Promise<void>;
  loadLiveSequences(database: Database, now: Date): Promise<LiveSequence[]>;
  buildGate(database: Database): OutboundGatePorts;
  /** The reconciliation primitive's send-boundary gate (VIL-293). REQUIRED (rule #11):
   * a lane that could silently skip it would send exactly the claims it exists to stop. */
  refuseUnbackedSend: typeof refuseUnbackedSend;
  dedupeActive(database: Database, dedupeKey: string): Promise<boolean>;
  /** The ONE send-side reader (sms-consent-core). It carries the verified +
   * non-revoked predicate itself, so a channel that may not be texted resolves to no
   * number whatever ran before it — which matters most here, where the urgent legs
   * are exempt from quiet hours. */
  resolveSendablePhone(database: Database, parentUserId: string): Promise<string | null>;
  recordSend(database: Database, write: SequenceLedgerWrite): Promise<string>;
  audit(database: Database, row: SequenceAuditRow): Promise<void>;
  /**
   * MEM-10 · the open-loops ledger. Both REQUIRED for the reason `transport` is (rule
   * #11): the heads-up leg tells an approved household "I'll send your plan the
   * evening before", and a ladder assembled without these would make that sentence the
   * only record of it — a promise nobody can count, and nobody can see broken.
   */
  recordCommitment: typeof recordCommitment;
  fulfillCommitment: typeof fulfillCommitment;
  /**
   * The outbound SMS leg — REQUIRED, and that is the point (VIL-262). It was nullable
   * so a caller could decide + compose without sending, and the three P0s this ladder
   * shipped with were all the same shape: a leg composed perfectly and dropped on the
   * floor because nothing was wired to send it. A sweep that cannot express "no
   * transport" cannot silently do that. A caller that genuinely wants no send belongs
   * behind an explicit, result-visible flag, never behind an absent dependency.
   */
  transport: ChannelTransport;
  /**
   * Put the sent leg in the parent's own text thread — REQUIRED, same reason as the
   * three above (rule #11). This ladder is the one Hale runs as a CONVERSATION: the
   * heads-up asks for a YES, the battle plan is answered the morning of, and the
   * check-in asks how it went. `channel_messages` carries no body (rule #1), so a leg
   * that skips this leaves the parent's answer with no antecedent the coach can read —
   * and it answers a question Hale cannot see itself having asked. There is no "no
   * thread" to express: the anchor is derived from the family and parent ids
   * (lib/channel/thread.ts).
   */
  threadMessage: typeof threadProactiveMessage;
  /**
   * VIL-338 · the send-time course read — REQUIRED, and for the reason `transport` is
   * (rule #11). The battle plan and the go leg SPEAK about a bound course, and a sweep
   * assembled without this would compose those sentences from a page nobody read while
   * reporting a perfectly ordinary `sent`. There is no "no fetcher" to express: a
   * failed read is a VERDICT with its own honest sentence (`page_unreadable`), which is
   * a different thing from having no way to read at all.
   */
  fetchBody: FetchPage;
  /**
   * The one write a send-time read may cause, and only at the battle plan: the page has
   * moved its own clock, so the anchor the rest of the ladder hangs from moves with it.
   * Guarded (`WHERE course_opens_at IS DISTINCT FROM $new`) so a double tick is a no-op,
   * and it returns whether a row actually moved — the number the leg's audit row carries
   * is about a change that happened, never one that was merely attempted. REQUIRED for
   * the reason above: an anchor that silently failed to move fires the flagship text on
   * the wrong morning, which is the one failure this ticket exists to prevent.
   */
  refreshCourseAnchor(
    database: Database,
    input: { sequenceId: string; courseOpensAt: Date; now: Date },
  ): Promise<boolean>;
}

/**
 * What a send-time read produced, by name — the verdict kinds plus the one thing a read
 * can DO rather than say. `anchor_moved` counts guarded refreshes that landed, so the
 * founder signal "a municipality is disagreeing with the M1 dataset" rides a counter
 * rather than a family-scoped audit verb about public reference data.
 */
export type PrepFate = PrepVerdict['kind'] | 'anchor_moved';

const PREP_FATES: readonly PrepFate[] = [
  'prepared',
  'registration_closed',
  'late_by_drift',
  'window_moved',
  'age_ineligible',
  'course_gone',
  'page_unreadable',
  'anchor_moved',
];

export interface SequenceRunResult {
  /** False when neither the flag nor the allowlist armed the sweep (D21). */
  enabled: boolean;
  /** Shortlists claimed AND drafted this run. */
  proposed: number;
  /** Live sequences examined in the leg phase. */
  evaluated: number;
  sent: number;
  /** Live sequences with no leg due — the common outcome on most ticks. */
  quiet: number;
  deduped: number;
  /**
   * Legs whose wire body claimed a row that does not exist, refused at the send boundary
   * (VIL-293). Its own count and not folded into `failed`: nothing broke, and a non-zero
   * here means a TEMPLATE in copy.ts is asserting something this family's ledger does not
   * hold — a bug in the sentence rather than in the run (rule #11).
   */
  refused: number;
  failed: number;
  held: Record<ProactiveHoldReason, number>;
  /**
   * VIL-338 · every fate a send-time course read produced, by name. A degraded reading
   * is never folded into `failed` (nothing broke) or into `sent` alone (the parent got a
   * different, truthful sentence), because the two questions a founder asks of this run
   * are "did everyone hear from us" and "what did the portals say" — and one number
   * cannot answer both.
   */
  prep: Record<PrepFate, number>;
  /** Course pages actually fetched: one GET per distinct URL per run, cache hits free. */
  read: number;
  /** Bound legs that SENT without a read because the run's wall budget was spent. Its
   * own count, because the family was still texted — with the link and the honest
   * sentence — and a run that skips reads is a run that is too slow, not one that
   * failed. */
  readSkipped: number;
  /** Bound legs sent for a course no live M1 band admits any more. The band is
   * reference data about a season; the bound course is the parent's own choice, and
   * this is the count of the times the two disagreed. */
  noFit: number;
}

function emptyResult(enabled: boolean): SequenceRunResult {
  return {
    enabled,
    proposed: 0,
    evaluated: 0,
    sent: 0,
    quiet: 0,
    deduped: 0,
    refused: 0,
    failed: 0,
    held: { not_enrolled: 0, no_watch_consent: 0, frequency_cap: 0, quiet_hours: 0 },
    prep: Object.fromEntries(PREP_FATES.map((fate) => [fate, 0])) as Record<PrepFate, number>,
    read: 0,
    readSkipped: 0,
    noFit: 0,
  };
}

/**
 * A leg's natural identity: one send per family per window per leg, ever. The ledger
 * carries it, so an interval that spans a hundred ticks still produces one message and
 * a re-fired cron costs one indexed read.
 */
export function legDedupeKey(familyId: string, windowId: string, leg: SequenceLeg): string {
  return `registration_sequence:${familyId}:${windowId}:${leg}`;
}

// ── phase A: propose a shortlist ─────────────────────────────────────────────

async function proposeForFamily(
  database: Database,
  family: SequenceFamily,
  deps: SequenceRunDeps,
  now: Date,
): Promise<boolean> {
  if (!family.areaCoarse) return false;
  const [children, windowRows, claimed] = await Promise.all([
    deps.loadChildren(database, family.familyId),
    deps.loadWindows(database, family.areaCoarse),
    deps.loadClaimedWindowIds(database, family.familyId),
  ]);
  if (children.length === 0) return false;

  // Every child's age, 13+ included. M4 drops teens before matching; a teen's
  // registration deadline is real, and the shortlist keeps their name out of it
  // instead of keeping them out of the shortlist (see shortlist.ts).
  const matches = matchRegistrationWindows({
    windows: windowRows,
    postal: family.areaCoarse,
    childrenAgesMonths: children.map((child) => ageInMonths(child.dateOfBirth, now)),
    now,
  });

  const horizon = now.getTime() + SHORTLIST_LEAD_DAYS * 86_400_000;
  for (const match of matches) {
    if (match.opensForFamilyAt.getTime() > horizon) break; // sorted soonest-first
    // ONE window at a time. The slot is a whole HOUR and the cron ticks every five
    // minutes, so `continue` here would claim the next window on the next tick and a
    // family with three matched dates would collect three approval cards a quarter of
    // an hour apart. A household preparing for a registration morning is preparing for
    // ONE; the next is proposed once this window has passed. (A declined shortlist also
    // holds the slot until its date passes — conservative, and it self-clears.)
    // Any cycle in this collapsed event counts as claimed: the group is one
    // registration morning, and a claim on any of its rows already produced the card.
    if (match.cycleWindows.some((cycle) => claimed.has(cycle.id))) return false;
    const shortlist = buildShortlist(match, children, now);
    if (!shortlist) continue;

    // CLAIM FIRST. The unique (family_id, window_id) index is what makes two
    // overlapping ticks produce one approval card; drafting first and claiming after
    // would mint the duplicate before the index could refuse it.
    const sequenceId = await deps.claimWindow(database, {
      familyId: family.familyId,
      windowId: match.window.id,
      parentUserId: family.parentUserId,
    });
    if (sequenceId === null) return false;

    try {
      const actionId = await deps.draftShortlist(database, {
        familyId: family.familyId,
        actorUserId: family.parentUserId,
        // Family-scoped: one municipal window is registered for as a household, and a
        // shortlist may cover two siblings at once.
        childId: null,
        intentKind: 'registration_shortlist',
        // NULL, and it is the same null every leg below is handed: nothing in this
        // module yet reads `course_url`, `course_opens_at` or `readiness_ready` off the
        // row, so no household is on the portal ladder and the card must not enumerate
        // a fourth text nobody will send. The registry lookup lands with the loader
        // that reads those three columns, in one change — the sentence a parent
        // consents to and the legs they then receive have to move together.
        rationale: renderShortlistRationale(shortlist, family.timeZone, now, null),
        // The card's own copy. Without these the approvals surface showed the generic
        // "Note in your daily digest" over the raw payload keys, so the municipality,
        // the date, the link and the "I never register for you" line — the things the
        // quiet-hours exemption is granted on the strength of — were invisible.
        title: windowPhrase(shortlist),
        sourceUrl: shortlist.sourceUrl,
      });
      await deps.attachAction(database, sequenceId, actionId);
      await deps.audit(database, {
        familyId: family.familyId,
        actor: 'system',
        actionTaken: 'registration_shortlist_drafted',
        targetTable: 'registration_sequences',
        targetId: sequenceId,
        after: {
          windowId: match.window.id,
          municipality: match.window.municipality,
          cycleLabel: match.window.cycleLabel,
          actionId,
          children: shortlist.fitNotes.length,
        },
      });
    } catch (err) {
      // A claim with no shortlist behind it is the worst of both worlds: it blocks M4's
      // nudge for this window AND never runs a leg, so the family goes silent about a
      // date they were owed. Release it and let the next tick try again.
      await deps.releaseClaim(database, sequenceId);
      throw err;
    }
    // ONE shortlist per family per run. A household with three matched windows gets
    // them one at a time, not an approvals queue nobody reads.
    return true;
  }
  return false;
}

// ── phase B: run the legs ────────────────────────────────────────────────────

/** What a read caused, carried out of the leg alongside its outcome so the summary can
 * count the reading and the send separately — a refused leg still read a page. */
interface LegReadEffects {
  prep?: PrepFate;
  anchorMoved?: boolean;
  noFit?: boolean;
}

type LegOutcome = (
  | { kind: 'held'; reason: ProactiveHoldReason }
  | { kind: 'quiet' }
  | { kind: 'deduped' }
  | { kind: 'refused' }
  | { kind: 'sent' }
) &
  LegReadEffects;

/**
 * VIL-338 · the run's ONE course reader: one GET per distinct URL, one wall-clock budget
 * for the whole run, and no throw.
 *
 * ONE GET PER URL because two households can be waiting on the same class and a public
 * body's server should not be asked twice for the same bytes in one tick.
 *
 * A WALL BUDGET rather than a read count, because phase B is a serial loop and the go
 * leg's interval is fifteen minutes wide: what has to be bounded is how long the run
 * takes, not how many pages it looked at. Past the budget a bound leg still SENDS — with
 * the page_unreadable sentence and the deep link, which is strictly better than a family
 * hearing nothing because five other families' portals were slow.
 *
 * NO THROW, because a throw inside `runLegForSequence` costs that family the whole tick
 * and counts `failed`. A failed read is a verdict with a true sentence, and this is
 * where it becomes one.
 */
function courseReader(fetchBody: FetchPage, startedAt: number) {
  const getPage = pageCache(fetchBody);
  const fetched = new Set<string>();
  const tally = { read: 0, skipped: 0 };
  return {
    tally,
    async read(url: string): Promise<PrepInput> {
      if (!fetched.has(url)) {
        if (Date.now() - startedAt > READ_WALL_BUDGET_MS) {
          tally.skipped += 1;
          return { ok: false, reason: 'wall_budget' };
        }
        fetched.add(url);
        tally.read += 1;
      }
      try {
        return { ok: true, raw: await getPage(url) };
      } catch (err) {
        // The host, never the family: a log line about a municipal page is not a fact
        // about a household (rule #1).
        console.error({ err, url }, 'registration sequence: course page read failed');
        return { ok: false, reason: 'fetch_failed' };
      }
    },
  };
}

type CourseReader = ReturnType<typeof courseReader>;

/** The sanitized URL's own courseId — what the reader checks the page's `EventId`
 * against, so a portal serving somebody else's class is `wrong_course` rather than a
 * confident sentence about the wrong course.
 *
 * TOTAL, because a throw here costs the family the whole tick and counts `failed`. The
 * stored URL was rebuilt by `sanitizeSpotUrl` so an unparseable one cannot exist — and
 * if one ever did, "I could not read the page" is the true sentence, not silence. */
function courseIdOf(url: string): string | null {
  try {
    return new URL(url).searchParams.get('courseId');
  } catch {
    return null;
  }
}

async function runLegForSequence(
  database: Database,
  sequence: LiveSequence,
  deps: SequenceRunDeps,
  reader: CourseReader,
  now: Date,
): Promise<LegOutcome> {
  // THIS family's open instant, not the general one. A resident household in a town
  // that publishes a head start registers a week early, and a ladder anchored on the
  // general date would tap them on the shoulder days after their doors had opened.
  const { isResidentWindow, opensForFamilyAt } = resolveFamilyOpen(
    sequence.window,
    sequence.areaCoarse,
  );
  // THE ANCHOR. The course page's own clock where the parent has bound one, and the M1
  // row's family-open instant otherwise. Fed to `dueLeg`, to every interval and to the
  // copy from this ONE place, so the morning the ladder is scheduled on and the morning
  // its sentences name can never be two different instants.
  const anchor = sequence.courseOpensAt ?? opensForFamilyAt;
  // From the registry, never from the row: a municipality Hale has learned to read is a
  // code fact, and it is what lights the readiness leg and the two send-time reads.
  const portal = portalForMunicipality(sequence.window.municipality);
  const leg = dueLeg(
    {
      openAt: anchor,
      timeZone: sequence.timeZone,
      optIn: sequence.optIn,
      outcome: sequence.outcome,
      waitlistStartedAt: sequence.waitlistStartedAt,
      waitlistResponseHours: sequence.window.waitlistResponseHours,
      portal,
    },
    now,
  );
  if (leg === null) return { kind: 'quiet' };

  const dedupeKey = legDedupeKey(sequence.familyId, sequence.window.id, leg);
  // Checked BEFORE the gate: a leg that already went out costs one indexed read on
  // every one of the hundreds of ticks its interval spans.
  if (await deps.dedupeActive(database, dedupeKey)) return { kind: 'deduped' };

  const verdict = await assertProactiveSendAllowed(
    {
      familyId: sequence.familyId,
      parentUserId: sequence.parentUserId,
      kind: 'registration_sequence',
      now,
      urgent: legIsUrgent(leg),
    },
    deps.buildGate(database),
  );
  if (!verdict.allowed) return { kind: 'held', reason: verdict.reason };

  const children = await deps.loadChildren(database, sequence.familyId);
  const match = matchForSequence(sequence, { isResidentWindow, opensForFamilyAt: anchor });
  // The two legs that SPEAK about the bound course, and therefore the only two that read
  // its page. Every other leg is about the municipal window and needs no network. Kept
  // as ONE narrowed value rather than a boolean, so nothing below can reach for a URL or
  // a portal the condition has not proved is there.
  const boundCourse =
    sequence.courseUrl !== null && portal !== null && (leg === 'battle_plan' || leg === 'go')
      ? { url: sequence.courseUrl, portal }
      : null;
  const fitted = buildShortlist(match, children, now);
  // A family whose children no longer fit the band (a birthday crossed the ceiling
  // between the proposal and the leg) has nothing honest left to be told ABOUT THE
  // WINDOW — but a bound course is the parent's own pick and the page is its record, so
  // that leg still goes and the disagreement is counted by name.
  if (fitted === null && boundCourse === null) return { kind: 'quiet' };
  const shortlist = fitted ?? windowShortlist(match);
  const effects: LegReadEffects = fitted === null ? { noFit: true } : {};

  let prep: { verdict: PrepVerdict; courseUrl: string } | null = null;
  if (boundCourse !== null) {
    prep = {
      verdict: await readCourse(reader, boundCourse.url, boundCourse.portal, {
        anchor,
        isResidentWindow,
        children,
        now,
        readinessReady: sequence.readinessReady,
      }),
      courseUrl: boundCourse.url,
    };
    effects.prep = prep.verdict.kind;
    // The anchor moves at the battle plan and NEVER at the go leg, whose key is already
    // spent: moving an interval a leg has fired in is a change no later tick can undo.
    const moved = movedClockOf(prep.verdict);
    if (leg === 'battle_plan' && moved !== null) {
      effects.anchorMoved = await deps.refreshCourseAnchor(database, {
        sequenceId: sequence.sequenceId,
        courseOpensAt: moved,
        now,
      });
    }
  }

  const body = renderSequenceLeg(leg, {
    shortlist,
    timeZone: sequence.timeZone,
    now,
    optIn: sequence.optIn,
    anchor,
    portal,
    readinessReady: sequence.readinessReady,
    prep,
    waitlist: {
      position: sequence.waitlistPosition,
      deadlineAt:
        sequence.waitlistStartedAt === null
          ? null
          : waitlistDeadline(sequence.waitlistStartedAt, sequence.window.waitlistResponseHours),
    },
  });

  const to = await deps.resolveSendablePhone(database, sequence.parentUserId);
  if (!to) {
    // The gate just said this parent has a live channel, so there IS one — a missing
    // number here is a contradiction, not a state to paper over.
    throw new Error(`runRegistrationSequenceCron: no send target for ${sequence.parentUserId}`);
  }

  // THE GATE, ON THE STRING THAT ACTUALLY LEAVES (VIL-293) — after `withOptOut`, because
  // everything between a gate and the transport is unchecked by construction. The ladder's
  // own legs are the one template set that DOES claim a registration watch, and they are
  // true because a live sequence is what is sending them: the reconcile matches on that
  // row rather than on the sentence. What it stops is a leg rendered for a household whose
  // sequence has gone (a claim nothing backs) and any future copy change that asserts a
  // booking or a promise about Hale itself.
  const wireBody = withOptOut(body, verdict.optOut);
  const unbacked = await deps.refuseUnbackedSend(database, {
    familyId: sequence.familyId,
    body: wireBody,
    now,
  });
  if (unbacked.length > 0) {
    console.error(
      { sequenceId: sequence.sequenceId, leg, reasons: unbacked },
      'registration sequence: the wire body claims a row that does not exist - leg refused',
    );
    return { kind: 'refused', ...effects };
  }

  const { providerMessageId } = await deps.transport.send({ to, body: wireBody });
  const messageId = await deps.recordSend(database, {
    familyId: sequence.familyId,
    parentUserId: sequence.parentUserId,
    channel: 'sms',
    category: 'registration_sequence',
    templateKey: `registration_sequence:${leg}`,
    dedupeKey,
    status: acceptedStatus('sms'),
    providerMessageId,
    sentAt: now,
  });
  await deps.audit(database, {
    familyId: sequence.familyId,
    actor: 'system',
    actionTaken: 'registration_sequence_leg_sent',
    targetTable: 'channel_messages',
    targetId: messageId,
    // Enum-shaped provenance only, never the rendered body (rule #1). The three VIL-338
    // fields are the whole receipt for a send-time read: WHICH sentence the page earned,
    // how far the page's clock sat from the anchor, and whether the anchor was moved.
    // The M1 row's own disagreement rides here rather than in an audit verb of its own —
    // a fact about public reference data is not an event in a family's history.
    after: {
      leg,
      windowId: sequence.window.id,
      municipality: sequence.window.municipality,
      cycleLabel: sequence.window.cycleLabel,
      urgent: legIsUrgent(leg),
      ...(prep === null
        ? {}
        : {
            prep: prep.verdict.kind,
            driftMinutes: driftOf(prep.verdict),
            anchorMovedMinutes: effects.anchorMoved === true ? driftOf(prep.verdict) : null,
          }),
    },
  });

  await recordLegPromise(
    database,
    { sequence, shortlist, leg, messageId, anchor, prep: prep?.verdict ?? null },
    deps,
    now,
  );
  // THE THREAD, which is where the parent's answer will be read. Unconditional and
  // AFTER the send, like the promise write above: a leg that never reached a transport
  // is not something Hale said. The COMPOSED leg, never the wire body — the CASL line
  // belongs on the wire and nowhere else.
  await deps.threadMessage(database, {
    familyId: sequence.familyId,
    parentUserId: sequence.parentUserId,
    body,
  });
  return { kind: 'sent', ...effects };
}

/** THIS tick's reading of the bound course. Pure once the bytes are in hand: the verdict
 * is a function of the page, the anchor and the family, and it never touches a clock or
 * a database of its own (prepare.ts). */
async function readCourse(
  reader: CourseReader,
  url: string,
  portal: SpotPortal,
  ctx: {
    anchor: Date;
    isResidentWindow: boolean;
    children: readonly SequenceChild[];
    now: Date;
    readinessReady: boolean | null;
  },
): Promise<PrepVerdict> {
  const courseId = courseIdOf(url);
  // A stored URL with no courseId cannot exist (`sanitizeSpotUrl` rebuilt it to exactly
  // two GUID parameters), and if one ever did, the honest answer is that Hale could not
  // read the page — not a page read against the wrong class.
  if (courseId === null) return { kind: 'page_unreadable', reason: 'wrong_course' };
  return readCoursePrep(await reader.read(url), {
    now: ctx.now,
    courseId,
    timeZone: portal.timeZone,
    isResidentWindow: ctx.isResidentWindow,
    anchor: ctx.anchor,
    children: ctx.children.map((child) => ({
      id: child.id,
      dateOfBirth: child.dateOfBirth,
      dobPrecision: child.dobPrecision,
    })),
    readinessReady: ctx.readinessReady,
  });
}

/** The page's own clock where this reading says the anchor is WRONG, or null. Both drift
 * verdicts carry one and nothing else may move the anchor: a `prepared` page agrees with
 * it within the tolerance, and a page nobody could read has no clock to move it to. */
function movedClockOf(verdict: PrepVerdict): Date | null {
  if (verdict.kind !== 'window_moved' && verdict.kind !== 'late_by_drift') return null;
  return verdict.clock?.at ?? null;
}

/** The page's clock minus the anchor, in whole minutes — null for a reading that never
 * got a clock. */
function driftOf(verdict: PrepVerdict): number | null {
  return 'anchorDriftMinutes' in verdict ? verdict.anchorDriftMinutes : null;
}

/**
 * MEM-10 · the ladder's own promise, opened and closed.
 *
 * ONE leg makes a commitment and ONE leg keeps it. The heads-up tells an approved
 * household "I'll send your plan the evening before" — a sentence with a deadline in
 * it — and the battle plan is the message that makes good. Both are written AFTER the
 * send, against the row that carried it, so a leg that never reached a transport neither
 * opens a debt nor discharges one.
 *
 * The promise is conditional on the parent having approved: {@link headsUpPromisesPlan}
 * is the same predicate the copy branches on, so an unapproved household — who is being
 * ASKED to approve, not promised anything — cannot be recorded as owed a plan.
 *
 * The due time is the END of the battle-plan interval, which is the go leg's start: past
 * that instant "the evening before" is no longer a thing that can happen, and a promise
 * that cannot be kept is late whatever else the ladder does next.
 */
async function recordLegPromise(
  database: Database,
  args: {
    sequence: LiveSequence;
    shortlist: Shortlist;
    leg: SequenceLeg;
    messageId: string;
    /** The instant the ladder is running on — the bound course's clock where there is
     * one, so a promise's deadline moves with the morning it is about. */
    anchor: Date;
    /** THIS tick's reading of the bound course, where one happened. */
    prep: PrepVerdict | null;
  },
  deps: SequenceRunDeps,
  now: Date,
): Promise<void> {
  const { sequence, leg, messageId } = args;
  if (leg === 'heads_up' && headsUpPromisesPlan(sequence.optIn)) {
    await deps.recordCommitment(database, {
      familyId: sequence.familyId,
      kind: 'registration_plan',
      // The municipality and the cycle, and nothing else: a household's plan is about a
      // window, and no child's name has to appear for a founder or a parent to read it
      // (rule #1).
      summary: `${windowPhrase(args.shortlist)}: your plan, the evening before.`,
      dueAt: openLegWindows(args.anchor, sequence.timeZone).battle_plan.until,
      channelMessageId: messageId,
    });
    return;
  }
  if (leg === 'battle_plan') {
    await deps.fulfillCommitment(database, {
      familyId: sequence.familyId,
      kind: 'registration_plan',
      channelMessageId: messageId,
      now,
    });
  }
  // THE COACH'S OWN WATCH, KEPT (VIL-293). A parent who asked Hale to watch a registration
  // morning was promised a text before the doors open, and this is that text. It is the
  // `go` leg and nothing earlier: the heads-up warns a week out and the battle plan hands
  // over a plan the evening before, and closing on either would file the promise as kept
  // while the parent is still waiting for the thing they were actually promised.
  //
  // VIL-338 · AND the battle plan that read a course already open. `late_by_drift` moves
  // the anchor into the past, so no go leg will ever fire under that key — this send,
  // which carried the sign-in link, IS the text before the doors open, and leaving the
  // promise open would report a debt Hale had already paid.
  if (leg === 'go' || (leg === 'battle_plan' && args.prep?.kind === 'late_by_drift')) {
    await deps.fulfillCommitment(database, {
      familyId: sequence.familyId,
      kind: 'registration_watch',
      channelMessageId: messageId,
      now,
    });
  }
}

/** The match a leg's shortlist is rebuilt from, against the LIVE window and today's
 * ages rather than stored: a child ages, a municipality corrects a band or a date, and
 * a leg must say what is true this morning. */
function matchForSequence(
  sequence: LiveSequence,
  open: { isResidentWindow: boolean; opensForFamilyAt: Date },
): RegistrationMatch {
  return {
    window: sequence.window,
    // The sequence stores ONE window id, so a leg re-renders that cycle alone. The
    // co-opening siblings only matter at proposal time, where the shortlist is built
    // from the live match.
    cycleWindows: [sequence.window],
    matchedChildAgesMonths: [],
    // The per-child hedge is rebuilt from the live band by buildShortlist itself, so
    // there is nothing for the match-level flag to carry here.
    ageApproximate: false,
    isResidentWindow: open.isResidentWindow,
    opensForFamilyAt: open.opensForFamilyAt,
    generalOpenAt: sequence.window.openAt,
  };
}

export async function runRegistrationSequenceCron(
  database: Database,
  deps: SequenceRunDeps = defaultSequenceRunDeps(),
  now: Date = new Date(),
): Promise<SequenceRunResult> {
  const allFamilies = f14Enabled();
  const allowlist = f14Allowlist();
  if (!allFamilies && allowlist.size === 0) return emptyResult(false);

  const result = emptyResult(true);
  const armed = (family: { familyId: string }) => allFamilies || allowlist.has(family.familyId);

  // ── Phase A: propose ────────────────────────────────────────────────────────
  const families = (await deps.selectFamilies(database, now))
    .filter(armed)
    .filter((family) => isShortlistSlot(now, family.timeZone))
    .slice(0, MAX_SEQUENCE_FAMILIES_PER_RUN);

  for (const family of families) {
    try {
      if (await proposeForFamily(database, family, deps, now)) result.proposed += 1;
    } catch (err) {
      result.failed += 1;
      console.error({ err, familyId: family.familyId }, 'registration sequence: propose failed');
    }
  }

  // ── Phase B: run the legs ───────────────────────────────────────────────────
  const sequences = (await deps.loadLiveSequences(database, now))
    .filter(armed)
    .slice(0, MAX_SEQUENCE_FAMILIES_PER_RUN);

  // ONE reader for the whole phase, because the budget and the page cache are both
  // properties of the RUN: two households on one course cost one GET, and the wall clock
  // starts when the leg phase does rather than when the process did.
  const reader = courseReader(deps.fetchBody, Date.now());
  for (const sequence of sequences) {
    result.evaluated += 1;
    try {
      const outcome = await runLegForSequence(database, sequence, deps, reader, now);
      if (outcome.prep) result.prep[outcome.prep] += 1;
      if (outcome.anchorMoved) result.prep.anchor_moved += 1;
      if (outcome.noFit) result.noFit += 1;
      if (outcome.kind === 'held') result.held[outcome.reason] += 1;
      else result[outcome.kind] += 1;
    } catch (err) {
      // One family's bad data must not silence every family after it.
      result.failed += 1;
      console.error({ err, sequenceId: sequence.sequenceId }, 'registration sequence: leg failed');
    }
  }
  result.read = reader.tally.read;
  result.readSkipped = reader.tally.skipped;
  return result;
}

// ── prod wiring ──────────────────────────────────────────────────────────────

/**
 * The families a shortlist could be proposed to: settled SMS families with a primary
 * parent. Consent, enrolment and the clock are the GATE's business — selecting on them
 * here would put the same policy in two places and let them disagree.
 */
async function selectSequenceFamilies(database: Database): Promise<SequenceFamily[]> {
  return database
    .select({
      familyId: schema.families.id,
      areaCoarse: schema.families.areaCoarse,
      parentUserId: schema.users.id,
      timeZone: schema.users.timezone,
    })
    .from(schema.families)
    .innerJoin(
      schema.familyMembers,
      and(
        eq(schema.familyMembers.familyId, schema.families.id),
        eq(schema.familyMembers.role, 'primary_parent'),
      ),
    )
    .innerJoin(schema.users, eq(schema.users.id, schema.familyMembers.userId))
    .where(eq(schema.families.onboardingStage, 'sms_active'));
}

/**
 * Every sequence that could still have a leg due: no outcome yet, or waitlisted (whose
 * guards are still ahead of it). A registered or missed window is finished.
 *
 * The opt-in is derived in the SAME query, from the approval spine's own columns, so
 * the leg phase costs one read for every sequence rather than one per sequence.
 */
async function loadLiveSequences(database: Database): Promise<LiveSequence[]> {
  const rows = await database
    .select({
      sequenceId: schema.registrationSequences.id,
      familyId: schema.registrationSequences.familyId,
      parentUserId: schema.registrationSequences.parentUserId,
      outcome: schema.registrationSequences.outcome,
      waitlistPosition: schema.registrationSequences.waitlistPosition,
      waitlistStartedAt: schema.registrationSequences.waitlistStartedAt,
      courseUrl: schema.registrationSequences.courseUrl,
      courseOpensAt: schema.registrationSequences.courseOpensAt,
      readinessReady: schema.registrationSequences.readinessReady,
      actionId: schema.registrationSequences.actionId,
      executedAt: schema.actions.executedAt,
      revertedAt: schema.actions.revertedAt,
      window: schema.registrationWindows,
      timeZone: schema.users.timezone,
      areaCoarse: schema.families.areaCoarse,
    })
    .from(schema.registrationSequences)
    .innerJoin(
      schema.registrationWindows,
      eq(schema.registrationWindows.id, schema.registrationSequences.windowId),
    )
    .innerJoin(schema.users, eq(schema.users.id, schema.registrationSequences.parentUserId))
    .innerJoin(schema.families, eq(schema.families.id, schema.registrationSequences.familyId))
    .leftJoin(schema.actions, eq(schema.actions.id, schema.registrationSequences.actionId))
    .where(
      or(
        isNull(schema.registrationSequences.outcome),
        eq(schema.registrationSequences.outcome, 'waitlisted'),
      ),
    );

  return rows.map((row) => ({
    sequenceId: row.sequenceId,
    familyId: row.familyId,
    parentUserId: row.parentUserId,
    timeZone: row.timeZone,
    areaCoarse: row.areaCoarse,
    window: row.window,
    optIn: optInOf(row),
    outcome: row.outcome,
    waitlistPosition: row.waitlistPosition,
    waitlistStartedAt: row.waitlistStartedAt,
    courseUrl: row.courseUrl,
    courseOpensAt: row.courseOpensAt,
    readinessReady: row.readinessReady,
  }));
}

/** The approval spine's answer, read off the joined action row. A reverted draft is a
 * decline, an executed one is the opt-in, and one still in the queue is neither. */
function optInOf(row: {
  actionId: string | null;
  executedAt: Date | null;
  revertedAt: Date | null;
}): SequenceOptIn {
  if (row.actionId === null) return 'missing';
  if (row.revertedAt !== null) return 'declined';
  return row.executedAt !== null ? 'opted_in' : 'pending';
}

export function defaultSequenceRunDeps(): SequenceRunDeps {
  return {
    selectFamilies: (database) => selectSequenceFamilies(database),
    loadChildren: async (database, familyId) =>
      database
        .select({
          id: schema.children.id,
          name: schema.children.name,
          dateOfBirth: schema.children.dateOfBirth,
          // Read so the send-time course read can refuse to decide a published age band
          // on a DOB Hale derived from a spoken age (rule #1, prepare.ts).
          dobPrecision: schema.children.dobPrecision,
        })
        .from(schema.children)
        .where(eq(schema.children.familyId, familyId)),
    loadWindows: (database, areaCoarse) => readRegistrationWindows(database, areaCoarse),
    loadClaimedWindowIds: (database, familyId) => loadClaimedWindowIds(database, familyId),
    claimWindow: async (database, input) => {
      const [row] = await database
        .insert(schema.registrationSequences)
        .values(input)
        .onConflictDoNothing({
          target: [
            schema.registrationSequences.familyId,
            schema.registrationSequences.windowId,
          ],
        })
        .returning({ id: schema.registrationSequences.id });
      return row?.id ?? null;
    },
    draftShortlist: async (database, input) => {
      // The SAME approval spine an Ask Hale chip uses: drafted, reviewed (rule #3), and
      // held at drafted_for_approval. Nothing here executes (rule #4), and the action
      // type it maps to has no executor that could register for anyone (D8).
      const { actionId } = await draftInlineAction(
        {
          familyId: input.familyId,
          actor: input.actorUserId,
          intentKind: input.intentKind,
          childId: input.childId,
          sourceAnswer: input.rationale,
          title: input.title,
          sourceUrl: input.sourceUrl,
          // Minted by this cron, not asked for by anyone. Without it the draft's event
          // and audit row would read `ask_hale` — the trail claiming a parent asked for
          // a shortlist Hale composed on its own (VIL-264).
          origin: 'registration_sweep',
          // Composed entirely from municipal registration rows — no child's words are
          // in it, and it is about the household rather than any one child. Declaring
          // that is what keeps the rule-#1 family fallback from redacting a card no
          // grant could ever unlock (VIL-260).
          contentProvenance: 'hale_authored',
        },
        database,
        pipelineClient(),
      );
      return actionId;
    },
    attachAction: async (database, sequenceId, actionId) => {
      await database
        .update(schema.registrationSequences)
        .set({ actionId, updatedAt: new Date() })
        .where(eq(schema.registrationSequences.id, sequenceId));
    },
    releaseClaim: async (database, sequenceId) => {
      await database
        .delete(schema.registrationSequences)
        .where(eq(schema.registrationSequences.id, sequenceId));
    },
    loadLiveSequences: (database) => loadLiveSequences(database),
    buildGate: buildOutboundGatePorts,
    refuseUnbackedSend,
    dedupeActive: (database, dedupeKey) => dedupeActive(dedupeKey, database),
    resolveSendablePhone,
    recordSend: async (database, write) => {
      const [row] = await database
        .insert(schema.channelMessages)
        .values({ ...write, direction: 'out' })
        .returning({ id: schema.channelMessages.id });
      if (!row) {
        throw new Error('runRegistrationSequenceCron: channel_messages insert returned no row');
      }
      return row.id;
    },
    audit: async (database, row) => {
      await database.insert(schema.auditLog).values(row);
    },
    transport: createTwilioTransport(),
    recordCommitment,
    fulfillCommitment,
    threadMessage: threadProactiveMessage,
    // The bare GET: no cookie, no User-Agent, no Referer, `redirect: 'error'`, a status
    // throw and a 4 MB ceiling. Six seconds, because this read happens inside a leg
    // whose interval is fifteen minutes wide.
    fetchBody: createFetchBody(GO_FETCH_TIMEOUT_MS),
    refreshCourseAnchor: async (database, input) => {
      const [row] = await database
        .update(schema.registrationSequences)
        .set({ courseOpensAt: input.courseOpensAt, updatedAt: input.now })
        .where(
          and(
            eq(schema.registrationSequences.id, input.sequenceId),
            sql`${schema.registrationSequences.courseOpensAt} is distinct from ${input.courseOpensAt}`,
          ),
        )
        .returning({ id: schema.registrationSequences.id });
      return row !== undefined;
    },
  };
}
