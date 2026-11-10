import type { AgentClient } from '@hale/agent';
import { type Database, type RegistrationWindow, schema } from '@hale/db';
import { ageInMonths } from '@hale/types';
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import {
  type FamilyTextRecipient,
  loadFamilyTextRecipients,
} from '~/lib/channel/family-recipients';
import { readWindows as readRegistrationWindows } from '~/lib/channel/intake/radar';
import type { ChannelTransport } from '~/lib/channel/intake/transport';
import type { ReplyLanguage } from '~/lib/channel/language';
import { type AcceptedStatus, acceptedStatus, dedupeActive } from '~/lib/channel/ledger';
import {
  deliverFamilyOutbound,
  familyOutboundTarget,
  householdCopies,
  notePermanentSkip,
} from '~/lib/channel/linq/family-outbound';
import { familyLanguage } from '~/lib/channel/linq/roster-ask';
import { f14Allowlist, f14Enabled } from '~/lib/channel/nudge/run';
import { type OptOutForm, withOptOut } from '~/lib/channel/opt-out';
import {
  type OutboundGatePorts,
  type ProactiveHoldReason,
  assertProactiveSendAllowed,
  buildOutboundGatePorts,
} from '~/lib/channel/outbound-gate';
import { createOutboundTransport } from '~/lib/channel/outbound-transport';
import { refuseUnbackedSend } from '~/lib/channel/reconcile/gate';
import { type SpotPortal, portalForMunicipality } from '~/lib/channel/spots/url';
import { threadProactiveMessage } from '~/lib/channel/thread';
import { resolveSendablePhone } from '~/lib/channels/sms-consent-core';
import { draftInlineAction } from '~/lib/coach/inline-action';
import { fulfillCommitment, recordCommitment } from '~/lib/commitments/ledger';
import { localParts } from '~/lib/loop/prefs';
import { voiceClient } from '~/lib/loop/voice/compose';
import { pipelineClient } from '~/lib/pipeline/client';
import { familyInPreviewScope } from '~/lib/preview/family-scope';
import {
  DATE_CHECK_OUTCOMES,
  type DateCheckMode,
  type DateCheckOutcome,
  type DateChecker,
  type DateUnreadReason,
  createDateChecker,
  liveDateReader,
} from '~/lib/registration/date-check';
import {
  type RegistrationMatch,
  matchRegistrationWindows,
  resolveFamilyOpen,
} from '~/lib/registration/match-registration-windows';
import type { RegistrationReader } from '~/lib/registration/read';
import { type FetchPage, createFetchBody, pageCache } from '~/lib/registration/verify-sweep';
import { loadClaimedWindowIds } from './claims.js';
import {
  type EveningFacts,
  type MorningFacts,
  approvalCardFacts,
  battlePlanDecision,
  dateMovedFacts,
  dateUnconfirmedFacts,
  headsUpFacts,
  headsUpPromisesPlan,
  legNoteFacts,
  morningFacts,
  windowPhrase,
} from './copy.js';
import { composeDateMoved, dateMovedBody } from './date-moved-compose.js';
import {
  type DateUnconfirmedFacts,
  composeDateUnconfirmed,
  dateUnconfirmedBody,
} from './date-unconfirmed-compose.js';
import { composeRegistrationEvening } from './evening-compose.js';
import { composeRegistrationHeadsUp } from './heads-up-compose.js';
import { composeRegistrationMorning } from './morning-compose.js';
import { type RegistrationNoteWriter, registrationNoteWriter } from './note-compose.js';
import {
  GO_FETCH_TIMEOUT_MS,
  type PrepInput,
  type PrepVerdict,
  READ_WALL_BUDGET_MS,
  readCoursePrep,
} from './prepare.js';
import {
  type DateWatchPatch,
  RECHECK_OUTCOMES,
  type RecheckOutcome,
  type RecheckSubject,
  lastSeenOpenAt,
  parsePendingChange,
  recheckWatchedDates,
} from './recheck.js';
import {
  HEADS_UP_MINUTE_LOCAL,
  type RegistrationOutcome,
  type SequenceLeg,
  type SequenceOptIn,
  dueLeg,
  legIsUrgent,
  openLegWindows,
  openTimeIsPublished,
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
export const MAX_SEQUENCE_FAMILIES_PER_RUN = 100;

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
   * date moves the whole ladder. Null for a watch a parent's link created (VIL-423). */
  window: RegistrationWindow | null;
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
  /** VIL-423 · the opening the page last showed, with its URL (recheck.ts). Scheduling
   * and change detection only; a dated text still reads the page at send time. */
  lastReading: Record<string, unknown> | null;
  /** VIL-423 · when the page is next due a scheduled read. Null is due now. */
  nextCheckAt: Date | null;
  /** VIL-423 · a moved opening the household is owed a note about. */
  pendingChange: Record<string, unknown> | null;
}

/** A ladder with a catalog row: the only kind a leg is composed and sent for. */
type CatalogSequence = LiveSequence & { window: RegistrationWindow };

export interface SequenceLedgerWrite {
  familyId: string;
  parentUserId: string;
  channel: 'sms' | 'imessage';
  category: 'registration_sequence';
  templateKey: string;
  dedupeKey: string;
  status: AcceptedStatus;
  providerMessageId: string;
  providerChatId?: string | null;
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
  /**
   * WHO THIS LADDER IS FOR — every parent seat in the family with a live number, not
   * the one parent whose id happens to sit on the sequence row.
   *
   * REQUIRED, for the reason `transport` is (rule #11). The row is the HOUSEHOLD's
   * ladder: one claim, one shortlist, one approval, one registration morning. A sweep
   * that could be assembled without this would compose the flagship 6:15 a.m. text and
   * deliver it to whichever parent happened to answer the intake, with the other
   * hearing about their child's registration morning from their partner — which is what
   * it did, against a site that promises them "the same radar and reminders, on their
   * own number".
   */
  loadRecipients(database: Database, familyId: string): Promise<FamilyTextRecipient[]>;
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
   * Guarded (`WHERE course_url = $url AND course_opens_at IS DISTINCT FROM $new`) so a
   * double tick is a no-op, and it returns whether a row actually moved — the number the
   * leg's audit row carries is about a change that happened, never one that was merely
   * attempted. REQUIRED for the reason above: an anchor that silently failed to move
   * fires the flagship text on the wrong morning, which is the one failure this ticket
   * exists to prevent.
   *
   * The URL is half the guard because the read takes seconds and a parent may paste a
   * second link inside them: a clock read off the OLD page is not a fact about the
   * course the row holds now, and the bind wrote that course's own clock already.
   */
  refreshCourseAnchor(
    database: Database,
    input: { sequenceId: string; courseUrl: string; courseOpensAt: Date; now: Date },
  ): Promise<boolean>;
  /**
   * The speak-lane client. Null when no key is configured. An evening text with
   * no client is unwritten: nothing is sent, and the miss is named (rule #11).
   */
  client: AgentClient | null;
  /** The parent's language. The model writes the evening text in it. */
  loadLanguage(database: Database, familyId: string): Promise<ReplyLanguage>;
  /** Facts in, one text out. Null means nothing is sent. */
  composeEvening: typeof composeRegistrationEvening;
  /** VIL-484 · the morning-of text when the page moved. Null means nothing is sent. */
  composeMorning: typeof composeRegistrationMorning;
  /** VIL-488 · the heads-up text, written from facts. Null means nothing is sent. */
  composeHeadsUp: typeof composeRegistrationHeadsUp;
  /** VIL-543 · the approval card and every other leg, written from facts. Null means
   * nothing is sent (and no card is drafted). */
  writeNote: RegistrationNoteWriter;
  /**
   * VIL-423 · the page reader the send-time date check uses, built once per run. Null
   * when no model key is configured: every check is then `unread` / `no_reader`, by name.
   */
  createDateReader(): RegistrationReader | null;
  /** VIL-423 · a dated leg the page did not corroborate, written without a date. Null
   * means nothing is sent. */
  composeDateUnconfirmed: typeof composeDateUnconfirmed;
  /**
   * VIL-423 · store what a scheduled page read found (recheck.ts). REQUIRED (rule #11):
   * a sweep that could not store it would re-read every page on every tick, and a moved
   * opening would never move the ladder.
   */
  saveDateWatch(database: Database, sequenceId: string, patch: DateWatchPatch): Promise<void>;
  /** VIL-423 · the note a household gets when the page moved an opening they were told.
   * Null means nothing is sent, and the change stays owed. */
  composeDateMoved: typeof composeDateMoved;
  /** The wall clock the already-open retry reads its deadline against. Defaults to
   * real time; tests pin it. */
  clock?: () => Date;
}

/** How many times an already-open evening draft is written before the miss is
 * logged for #ops. Each try is a full compose; only one text can leave. */
export const ALREADY_OPEN_DRAFT_TRIES = 3;

/**
 * What a send-time read produced, by name — the verdict kinds, the one thing a read can
 * DO rather than say, and the one morning where there was nothing to read. `anchor_moved`
 * counts guarded refreshes that landed, so the founder signal "a municipality is
 * disagreeing with the M1 dataset" rides a counter rather than a family-scoped audit verb
 * about public reference data. `unbound` counts the morning legs of a household whose
 * town Hale CAN read and who has pasted nothing: rung 1's adoption number, and the fate
 * that keeps such a leg's trail row distinguishable from the thirteen towns that have no
 * portal at all.
 */
export type PrepFate = PrepVerdict['kind'] | 'anchor_moved' | 'unbound';

const PREP_FATES: readonly PrepFate[] = [
  'prepared',
  'registration_closed',
  'late_by_drift',
  'window_moved',
  'age_ineligible',
  'course_gone',
  'page_unreadable',
  'anchor_moved',
  'unbound',
];

/**
 * Why a leg that WAS due did not go out (VIL-347). Not a hold — nothing is deferred and
 * no later tick will send it — and not `quiet`, which means nothing was due at all.
 *
 * `open_time_unpublished`: the go leg is a claim about a minute, and this window's
 * source published only a date, so there is no minute to claim. See
 * `openTimeIsPublished`.
 *
 * `date_unconfirmed` (VIL-423, `enforce`): the go leg's whole content is the stored
 * minute, and the page did not corroborate it. The battle plan the evening before
 * already carried what the page said, or the page to check.
 */
export type SequenceSkipReason = 'open_time_unpublished' | 'date_unconfirmed';

const SKIP_REASONS: readonly SequenceSkipReason[] = ['open_time_unpublished', 'date_unconfirmed'];

/** The legs that state the opening date or time, and so the only ones checked. */
const DATED_LEGS: ReadonlySet<SequenceLeg> = new Set([
  'heads_up',
  'readiness',
  'battle_plan',
  'go',
]);

/** Check outcomes where Hale never got the page's words at all, as opposed to a page it
 * read that did not confirm the date. */
const PAGE_UNREADABLE: ReadonlySet<DateUnreadReason> = new Set([
  'unreadable',
  'busy',
  'gone',
  'no_reader',
]);

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
   * Legs that were DUE and deliberately not sent, by reason (VIL-347). Its own count
   * beside `held`, because a hold is a deferral the next tick resolves and this is a
   * message that will never go: a non-zero here is a town whose published data cannot
   * support the leg, which is a data signal, not a delivery one (rule #11).
   */
  skipped: Record<SequenceSkipReason, number>;
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
  /**
   * Evening texts that were due and not sent because the model did not write
   * one. Nothing is held for later under another name: the dedupe key is
   * unspent, so the next tick tries again. Its own count (rule #11).
   */
  unwritten: number;
  /** Link watches with no open date yet: no dated leg exists and none is guessed. */
  undated: number;
  /** Link-watch legs that were due and held because no send-time read of the parent's
   * page exists yet. Nothing was sent and the dedupe key is unspent (slice 7b). */
  linkUnread: number;
  /** VIL-423 · send-time date checks of a catalog window's page, by outcome. Zero
   * everywhere while REGISTRATION_DATE_CHECK is off. */
  dateCheck: Record<DateCheckOutcome, number>;
  /** VIL-423 · what each ladder's scheduled page read found, by outcome. */
  dateRecheck: Record<RecheckOutcome, number>;
  /** Distinct pages the scheduled re-read asked for this tick. */
  recheckReads: number;
  /** Change notes sent: one per parent per moved opening. */
  dateMovedSent: number;
  /** Change notes cleared unsent because the household stopped the ladder or reported
   * how registration went before the note could go. */
  dateMovedDropped: number;
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
    held: { not_enrolled: 0, opt_out_unread: 0, no_watch_consent: 0, quiet_hours: 0 },
    skipped: Object.fromEntries(SKIP_REASONS.map((reason) => [reason, 0])) as Record<
      SequenceSkipReason,
      number
    >,
    prep: Object.fromEntries(PREP_FATES.map((fate) => [fate, 0])) as Record<PrepFate, number>,
    read: 0,
    readSkipped: 0,
    noFit: 0,
    unwritten: 0,
    undated: 0,
    linkUnread: 0,
    dateCheck: Object.fromEntries(DATE_CHECK_OUTCOMES.map((outcome) => [outcome, 0])) as Record<
      DateCheckOutcome,
      number
    >,
    dateRecheck: Object.fromEntries(RECHECK_OUTCOMES.map((outcome) => [outcome, 0])) as Record<
      RecheckOutcome,
      number
    >,
    recheckReads: 0,
    dateMovedSent: 0,
    dateMovedDropped: 0,
  };
}

/**
 * A leg's natural identity: one send per RECIPIENT per family per window per leg, ever.
 * The ledger carries it, so an interval that spans a hundred ticks still produces one
 * message per parent and a re-fired cron costs one indexed read each.
 *
 * THE RECIPIENT IS IN THE KEY, and it has to be rather than merely ought to be:
 * `channel_messages.dedupe_key` is UNIQUE where present, so a family-scoped key for a
 * two-parent household is not "one duplicate text" — it is one send and then a
 * duplicate-key crash on the second, which is how the ladder would have failed the
 * moment a co-parent was added to it (audit 2026-09-17).
 */
export function legDedupeKey(
  familyId: string,
  windowId: string,
  leg: SequenceLeg,
  parentUserId: string,
): string {
  return `registration_sequence:${familyId}:${windowId}:${leg}:${parentUserId}`;
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

    // VIL-543 · the card is written from facts. THE SAME REGISTRY LOOKUP THE LEGS RUN
    // ON (`dueLeg`), so the card enumerates exactly the texts this household will
    // receive: four where Hale has learned to read the town's portal and the readiness
    // leg therefore fires, three everywhere else. A card that cannot be written is no
    // card: the claim is released and the next tick tries again.
    const rationale = await deps.writeNote(
      database,
      family.familyId,
      approvalCardFacts(
        shortlist,
        family.timeZone,
        now,
        portalForMunicipality(match.window.municipality),
      ),
    );
    if (rationale === null) {
      // Nothing was drafted and nothing reaches the family, so this is a named log line
      // rather than a trail row a retrying tick would repeat.
      await deps.releaseClaim(database, sequenceId);
      console.error(
        { familyId: family.familyId, outcome: 'registration_shortlist_unwritten' },
        'registration sequence: the approval card could not be written, no card drafted',
      );
      return false;
    }

    try {
      const actionId = await deps.draftShortlist(database, {
        familyId: family.familyId,
        actorUserId: family.parentUserId,
        // Family-scoped: one municipal window is registered for as a household, and a
        // shortlist may cover two siblings at once.
        childId: null,
        intentKind: 'registration_shortlist',
        rationale,
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

/**
 * What one leg DID, counted per recipient rather than per sequence.
 *
 * A household is two numbers now, and a leg can honestly be sent to one parent and held
 * for the other — the co-parent whose local clock is past 21:00, the parent who pressed
 * STOP this morning. One enum per sequence could only report the first of those and
 * would silently lose the second, so every field here is a COUNT and `quiet` (no leg
 * due, or nothing honest left to say about the window) is the one that stays a property
 * of the sequence.
 */
type LegTally = LegReadEffects & {
  quiet: boolean;
  sent: number;
  deduped: number;
  refused: number;
  /** One entry per recipient the gate held, so two parents held for two different
   * reasons are counted as two different reasons. */
  held: ProactiveHoldReason[];
  /**
   * VIL-347 · the leg was DUE and was composed for nobody, because the window's own
   * published data cannot support the sentence. A property of the SEQUENCE, like
   * `quiet`, rather than a per-recipient count: the window is read before the household
   * is, so the answer is the same for one parent and for two.
   */
  skipped?: SequenceSkipReason;
  /** The evening text was due and the model did not write it. Nothing was sent. */
  unwritten?: number;
  /** A change note that is no longer owed: the ladder was stopped or finished. */
  dropped?: number;
};

function emptyTally(overrides: Partial<LegTally> = {}): LegTally {
  return { quiet: false, sent: 0, deduped: 0, refused: 0, held: [], ...overrides };
}

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
        // THE HOST AND THE ERROR'S CLASS, AND NOTHING ELSE (rule #1). A log line about a
        // slow municipal server is a fact about that server; the `courseId` in the URL is
        // the exact class one household is signing a child up for, and it is not needed
        // to read "Markham was unreachable this morning" off a log. NOT the error object:
        // the fetch primitive throws `page fetch ${url} → HTTP ${status}`, so logging
        // `err` carries the whole course URL into the log through its message.
        console.error(
          { name: err instanceof Error ? err.name : 'unknown', host: hostOf(url) },
          'registration sequence: course page read failed',
        );
        return { ok: false, reason: 'fetch_failed' };
      }
    },
  };
}

type CourseReader = ReturnType<typeof courseReader>;

/** The bare host of a stored course URL, for the one log line this module writes about a
 * read. TOTAL for the same reason `courseIdOf` is, and it falls back to the constant
 * string rather than to the URL: a line that cannot name its host still must not name a
 * family's class. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return 'unparseable';
  }
}

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
  sequence: CatalogSequence,
  deps: SequenceRunDeps,
  reader: CourseReader,
  checker: DateChecker,
  now: Date,
): Promise<LegTally> {
  // THE ANCHOR, from ladderAnchor. Fed to `dueLeg`, to every interval and to the copy
  // from this ONE place, so the morning the ladder is scheduled on and the morning its
  // sentences name can never be two different instants.
  const { isResidentWindow, anchor } = ladderAnchor(sequence, checker.mode);
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
  if (leg === null) return emptyTally({ quiet: true });
  // VIL-347 · THE 23:45 TEXT. The go leg is the one rung that names a MINUTE, and it
  // spends the quiet-hours exemption to do it. Where the town published a date and no
  // hour the row holds the start of that local day, and fifteen minutes before it is
  // 23:45 the night before — a text at the hour the exemption exists to protect, naming
  // a midnight nobody printed. The battle plan already carried the date that evening, so
  // what is lost is a sentence that was never true.
  //
  // DECIDED BEFORE THE HOUSEHOLD IS READ, above the recipient fan-out: there is no
  // honest version of this leg for anybody, so it is composed for nobody and sent to
  // nobody rather than held for each parent in turn.
  if (leg === 'go' && !openTimeIsPublished(anchor, sequence.timeZone)) {
    return emptyTally({ skipped: 'open_time_unpublished' });
  }

  // BOTH NUMBERS. The sequence row carries one parent id — the seat that was claimed —
  // and it is the ladder's owner, never its audience: one household, one registration
  // morning, one approval, and every parent on it hears the same six texts.
  const recipients = await deps.loadRecipients(database, sequence.familyId);
  if (recipients.length === 0) {
    // Nobody in this household can be texted right now. `not_enrolled` is exactly what
    // the gate would have said about the one parent it used to ask about, so it is what
    // is counted rather than a silence that looks like a quiet tick.
    return emptyTally({ held: ['not_enrolled'] });
  }

  // Per recipient, and checked BEFORE the gate: a leg that already went out costs one
  // indexed read on every one of the hundreds of ticks its interval spans.
  const pending: Array<{ recipient: FamilyTextRecipient; dedupeKey: string }> = [];
  let deduped = 0;
  for (const recipient of recipients) {
    const dedupeKey = legDedupeKey(
      sequence.familyId,
      sequence.window.id,
      leg,
      recipient.parentUserId,
    );
    if (await deps.dedupeActive(database, dedupeKey)) deduped += 1;
    else pending.push({ recipient, dedupeKey });
  }
  if (pending.length === 0) return emptyTally({ deduped });

  // EVERY RECIPIENT IS GATED BEFORE ANYBODY IS SENT TO, and the ordering is the design
  // rather than tidiness. The frequency cap is counted per FAMILY (outbound-gate.ts),
  // because a household is one audience — so gating and sending in one pass would let
  // the first parent's message spend the budget and hold the second under it. This
  // class is uncapped, and the nudge sweep beside it is not; the shape is the same in
  // both so that a cap added here later cannot quietly halve the household.
  const allowed: Array<{
    recipient: FamilyTextRecipient;
    dedupeKey: string;
    optOut: OptOutForm;
  }> = [];
  const held: ProactiveHoldReason[] = [];
  for (const { recipient, dedupeKey } of pending) {
    const verdict = await assertProactiveSendAllowed(
      {
        familyId: sequence.familyId,
        parentUserId: recipient.parentUserId,
        kind: 'registration_sequence',
        now,
        urgent: legIsUrgent(leg),
      },
      deps.buildGate(database),
    );
    if (verdict.allowed) allowed.push({ recipient, dedupeKey, optOut: verdict.optOut });
    else held.push(verdict.reason);
  }
  if (allowed.length === 0) return emptyTally({ deduped, held });

  const children = await deps.loadChildren(database, sequence.familyId);

  // VIL-423 · THE SEND-TIME DATE CHECK, for a dated leg whose opening comes from the
  // catalog row (a bound course is read off its own page at the battle plan and the go
  // leg). Shadow logs and changes nothing. Enforce states the stored opening only when
  // the page agrees: a page that disagrees lends the text its own date, and a page that
  // cannot confirm one gets the text with no date and the page to check. `stated` moves
  // only the sentence; the schedule stays on `anchor`, so the leg already due is the one
  // that goes and no interval is re-entered.
  let stated = anchor;
  let unconfirmed: DateUnconfirmedFacts['why'] | null = null;
  let dateCheck: DateCheckOutcome | undefined;
  if (checker.mode !== 'off' && sequence.courseOpensAt === null && DATED_LEGS.has(leg)) {
    const check = await checker.check(
      { window: sequence.window, resident: isResidentWindow, stated: anchor, sender: leg },
      now,
    );
    dateCheck = check.outcome;
    if (checker.mode === 'enforce' && check.outcome !== 'agree') {
      if (leg === 'go') return emptyTally({ skipped: 'date_unconfirmed', deduped, held });
      if (check.outcome === 'disagree' && check.liveAt.getTime() > now.getTime()) {
        stated = check.liveAt;
      } else {
        unconfirmed =
          check.outcome === 'unread' && PAGE_UNREADABLE.has(check.reason)
            ? 'page_unreadable'
            : 'page_unconfirmed';
      }
    }
  }

  const match = matchForSequence(sequence, { isResidentWindow, opensForFamilyAt: stated });
  // A course this family picked, on a portal Hale can read. Kept as ONE narrowed value
  // rather than a boolean, so nothing below can reach for a URL or a portal the
  // condition has not proved is there.
  const bound =
    sequence.courseUrl !== null && portal !== null ? { url: sequence.courseUrl, portal } : null;
  // The two legs that SPEAK about the bound course, and therefore the only two that read
  // its page. Every other leg is about the municipal window and needs no network.
  const boundCourse = leg === 'battle_plan' || leg === 'go' ? bound : null;
  const fitted = buildShortlist(match, children, now);
  // A family whose children no longer fit the band (a birthday crossed the ceiling
  // between the proposal and the leg) has nothing honest left to be told ABOUT THE
  // WINDOW — the heads-up and the readiness checklist both name who it fits, and a
  // ladder with no course bound has only the band to speak from.
  //
  // A bound ladder is a different thing after those two: the parent picked THIS course
  // and the page is its record, the two morning legs speak from that page, and the
  // check-in ("How did that go?") and the waitlist guards (a clock the parent's own
  // message started) never named who fits at all. Silence there would end the ladder
  // mid-sentence for the household this feature is for. Nothing changes for an unbound
  // ladder, which is every one of the thirteen municipalities Hale cannot read.
  const boundSpeaks = bound !== null && leg !== 'heads_up' && leg !== 'readiness';
  if (fitted === null && !boundSpeaks) return emptyTally({ quiet: true, deduped, held });
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
        // The page this clock was read off, so a link pasted while the read was in
        // flight keeps its own morning.
        courseUrl: boundCourse.url,
        courseOpensAt: moved,
        now,
      });
    }
  } else if (portal !== null && (leg === 'battle_plan' || leg === 'go')) {
    // A morning leg for a household whose town Hale can read, with nothing pasted: the
    // trail should say so in a word, or this row and a no-portal town's are the same row.
    effects.prep = 'unbound';
  }

  const legInput = {
    shortlist,
    timeZone: sequence.timeZone,
    now,
    optIn: sequence.optIn,
    anchor: stated,
    portal,
    readinessReady: sequence.readinessReady,
    prep,
    waitlist: { position: sequence.waitlistPosition, startedAt: sequence.waitlistStartedAt },
  };
  let body: string;
  if (unconfirmed !== null) {
    const facts = dateUnconfirmedFacts(leg, legInput, unconfirmed);
    const language = deps.client ? await deps.loadLanguage(database, sequence.familyId) : null;
    const written =
      deps.client && language
        ? await deps.composeDateUnconfirmed(deps.client, { ...facts, language }, sequence.familyId)
        : null;
    if (!written) {
      await deps.audit(database, {
        familyId: sequence.familyId,
        actor: 'system',
        actionTaken: 'registration_leg_unwritten',
        targetTable: 'registration_sequences',
        targetId: sequence.sequenceId,
        after: {
          leg,
          windowId: sequence.window.id,
          outcome: 'registration_leg_unwritten',
          version: 'date_unconfirmed',
        },
      });
      return { sent: 0, deduped, refused: 0, held, quiet: false, unwritten: 1, ...effects };
    }
    body = dateUnconfirmedBody(written, sequence.window.sourceUrl);
  } else if (leg === 'battle_plan') {
    const decision = battlePlanDecision(legInput);
    // VIL-484 · THE ALREADY-OPEN RETRY. The anchor has just moved to the page's past
    // clock, so no later tick reaches this leg again: a miss here is a parent who is
    // never told. It is written again while the text can still arrive before the
    // morning the ladder named, and never after.
    const retryable = decision.facts.situation === 'already_open';
    const tries = retryable ? ALREADY_OPEN_DRAFT_TRIES : 1;
    const clock = deps.clock ?? (() => new Date());
    let written: string | null = null;
    let attempts = 0;
    while (attempts < tries) {
      if (attempts > 0 && clock().getTime() >= anchor.getTime()) break;
      attempts += 1;
      written = await writeEvening(database, deps, sequence.familyId, decision.facts);
      if (written) break;
    }
    // IDEMPOTENT: a slow retry may overlap another tick. A key spent meanwhile means
    // that tick sent it, so this one sends nothing.
    if (written && attempts > 1) {
      for (let index = allowed.length - 1; index >= 0; index -= 1) {
        const entry = allowed[index];
        if (entry && (await deps.dedupeActive(database, entry.dedupeKey))) {
          allowed.splice(index, 1);
          deduped += 1;
        }
      }
      if (allowed.length === 0) return emptyTally({ deduped, held, ...effects });
    }
    if (!written) {
      if (retryable) {
        console.error(
          {
            sequenceId: sequence.sequenceId,
            outcome: 'registration_evening_unwritten',
            situation: 'already_open',
            attempts,
          },
          'registration sequence: already-open evening text unwritten after retries, nothing sent - for the #ops post',
        );
      }
      await deps.audit(database, {
        familyId: sequence.familyId,
        actor: 'system',
        actionTaken: 'registration_evening_unwritten',
        targetTable: 'registration_sequences',
        targetId: sequence.sequenceId,
        after: {
          leg,
          windowId: sequence.window.id,
          outcome: 'registration_evening_unwritten',
          ...(retryable ? { situation: 'already_open', attempts, ops: true } : {}),
        },
      });
      return { sent: 0, deduped, refused: 0, held, quiet: false, unwritten: 1, ...effects };
    }
    body = written;
  } else if (leg === 'go') {
    // VIL-484 · EVERY morning-of case is composed from facts; nothing is rendered.
    const facts: MorningFacts = morningFacts(legInput);
    const language = deps.client ? await deps.loadLanguage(database, sequence.familyId) : null;
    const written =
      deps.client && language
        ? await deps.composeMorning(deps.client, { ...facts, language }, sequence.familyId)
        : null;
    if (!written) {
      await deps.audit(database, {
        familyId: sequence.familyId,
        actor: 'system',
        actionTaken: 'registration_morning_unwritten',
        targetTable: 'registration_sequences',
        targetId: sequence.sequenceId,
        after: {
          leg,
          windowId: sequence.window.id,
          outcome: 'registration_morning_unwritten',
          situation: facts.situation,
        },
      });
      return { sent: 0, deduped, refused: 0, held, quiet: false, unwritten: 1, ...effects };
    }
    body = written;
  } else if (leg === 'heads_up' || (leg === 'readiness' && portal == null)) {
    // VIL-488 · the heads-up is composed from facts; there is no code sentence.
    const facts = headsUpFacts(legInput);
    const language = deps.client ? await deps.loadLanguage(database, sequence.familyId) : null;
    const written =
      deps.client && language
        ? await deps.composeHeadsUp(deps.client, { ...facts, language }, sequence.familyId)
        : null;
    if (!written) {
      await deps.audit(database, {
        familyId: sequence.familyId,
        actor: 'system',
        actionTaken: 'registration_heads_up_unwritten',
        targetTable: 'registration_sequences',
        targetId: sequence.sequenceId,
        after: {
          leg,
          windowId: sequence.window.id,
          outcome: 'registration_heads_up_unwritten',
        },
      });
      return { sent: 0, deduped, refused: 0, held, quiet: false, unwritten: 1, ...effects };
    }
    body = written;
  } else {
    // VIL-543 · the readiness checklist, the check-in and the waitlist guards are
    // written from facts too; there is no code sentence.
    const written = await deps.writeNote(database, sequence.familyId, legNoteFacts(leg, legInput));
    if (!written) {
      await deps.audit(database, {
        familyId: sequence.familyId,
        actor: 'system',
        actionTaken: 'registration_leg_unwritten',
        targetTable: 'registration_sequences',
        targetId: sequence.sequenceId,
        after: { leg, windowId: sequence.window.id, outcome: 'registration_leg_unwritten' },
      });
      return { sent: 0, deduped, refused: 0, held, quiet: false, unwritten: 1, ...effects };
    }
    body = written;
  }

  // ONE COMPOSED LEG, TWO ENVELOPES. The sentence is about the household's morning and
  // is rendered once, on the LADDER's clock (the sequence row's), so both parents read
  // the same time for the same registration. Only the CASL line differs per recipient:
  // whether this parent has been texted first before is a fact about them, and the gate
  // answered it for each of them above.
  const { sent, refused, promiseMessageId } = await deliverHouseholdText(database, deps, {
    familyId: sequence.familyId,
    sequenceId: sequence.sequenceId,
    templateKey: `registration_sequence:${leg}`,
    body,
    allowed,
    now,
    auditVerb: 'registration_sequence_leg_sent',
    // Enum-shaped provenance only, never the rendered body (rule #1). The three
    // VIL-338 fields are the whole receipt for a send-time read: WHICH sentence the
    // page earned, how far the page's clock sat from the anchor, and whether the
    // anchor was moved. The M1 row's own disagreement rides here rather than in an
    // audit verb of its own — a fact about public reference data is not an event in a
    // family's history.
    auditAfter: (recipient) => ({
      leg,
      windowId: sequence.window.id,
      municipality: sequence.window.municipality,
      cycleLabel: sequence.window.cycleLabel,
      urgent: legIsUrgent(leg),
      // Which SEAT this copy went to. The row already names the parent; this names
      // the relationship, which is what a founder reading the trail is asking.
      role: recipient.role,
      // `prep` alone on the leg that had a portal and nothing bound: there was no
      // read, so there is no drift to report and no anchor that could have moved.
      ...(effects.prep === undefined ? {} : { prep: effects.prep }),
      // VIL-423 · what the send-time date check said, and which text that earned.
      ...(dateCheck === undefined ? {} : { dateCheck }),
      ...(unconfirmed === null ? {} : { version: 'date_unconfirmed' }),
      ...(prep === null
        ? {}
        : {
            driftMinutes: driftOf(prep.verdict),
            anchorMovedMinutes: effects.anchorMoved === true ? driftOf(prep.verdict) : null,
          }),
    }),
  });

  // MEM-10 · ONCE PER LEG, not once per number. The promise is the HOUSEHOLD's — "I'll
  // send your plan the evening before" is one plan — so a second recordCommitment would
  // report a debt Hale does not owe, and a second fulfillCommitment would close a
  // promise that was never opened twice.
  if (promiseMessageId !== null) {
    await recordLegPromise(
      database,
      {
        sequence,
        shortlist,
        leg,
        messageId: promiseMessageId,
        anchor,
        prep: prep?.verdict ?? null,
        promisedPlan: unconfirmed === null,
      },
      deps,
      now,
    );
  }
  return { sent, deduped, refused, held, quiet: false, ...effects };
}

/**
 * One composed text to every gated seat of a household: the reconcile gate on the string
 * that leaves, the delivery, the ledger row, the audit row and the thread, per copy. A
 * group household gets one bubble, and the other seat's dedupe key is spent beside it.
 */
async function deliverHouseholdText(
  database: Database,
  deps: SequenceRunDeps,
  input: {
    familyId: string;
    sequenceId: string;
    templateKey: string;
    body: string;
    allowed: ReadonlyArray<{
      recipient: FamilyTextRecipient;
      dedupeKey: string;
      optOut: OptOutForm;
    }>;
    now: Date;
    auditVerb: string;
    auditAfter(recipient: FamilyTextRecipient): Record<string, unknown>;
  },
): Promise<{ sent: number; refused: number; promiseMessageId: string | null }> {
  let sent = 0;
  let refused = 0;
  let wireProvider: { id: string; chatId: string | null } | null = null;
  const target = await familyOutboundTarget(database, input.familyId);
  const wireCopies = householdCopies(target, input.allowed);
  const shadowed = target.channel === 'group' ? input.allowed.slice(wireCopies.length) : [];
  /** The row a family-scoped promise is opened and discharged against — the first leg
   * that actually left, in the reader's stable primary-parent-first order. */
  let promiseMessageId: string | null = null;

  for (const { recipient, dedupeKey, optOut } of wireCopies) {
    const to = await deps.resolveSendablePhone(database, recipient.parentUserId);
    if (!to) {
      // The gate just said this parent has a live channel, so there IS one — a missing
      // number here is a contradiction, not a state to paper over.
      throw new Error(`runRegistrationSequenceCron: no send target for ${recipient.parentUserId}`);
    }

    // THE GATE, ON THE STRING THAT ACTUALLY LEAVES (VIL-293) — after `withOptOut`, and
    // once per recipient because the string is per recipient: everything between a gate
    // and the transport is unchecked by construction. The ladder's own legs are the one
    // template set that DOES claim a registration watch, and they are true because a
    // live sequence is what is sending them: the reconcile matches on that row rather
    // than on the sentence. What it stops is a leg rendered for a household whose
    // sequence has gone (a claim nothing backs) and any future copy change that asserts
    // a booking or a promise about Hale itself.
    const wireBody = withOptOut(input.body, optOut);
    const unbacked = await deps.refuseUnbackedSend(database, {
      familyId: input.familyId,
      body: wireBody,
      now: input.now,
      lane: 'registration_sequence',
      parentUserId: recipient.parentUserId,
    });
    if (unbacked.length > 0) {
      console.error(
        { sequenceId: input.sequenceId, templateKey: input.templateKey, reasons: unbacked },
        'registration sequence: the wire body claims a row that does not exist - text refused',
      );
      refused += 1;
      continue;
    }

    const delivered = await deliverFamilyOutbound(database, {
      familyId: input.familyId,
      body: wireBody,
      to,
      legacy: deps.transport,
      target,
      bubbleKind: 'rec_morning',
    });
    if (delivered.status === 'held') {
      refused += 1;
      continue;
    }
    if (delivered.status === 'skipped') {
      refused += 1;
      console.warn(
        { sequenceId: input.sequenceId, code: delivered.reason },
        'registration sequence: outbound skipped',
      );
      if (delivered.reason !== 'not_configured') {
        await notePermanentSkip(database, {
          familyId: input.familyId,
          parentUserId: recipient.parentUserId,
          category: 'registration_sequence',
          templateKey: input.templateKey,
          dedupeKey,
          reason: delivered.reason,
          now: input.now,
        });
      }
      continue;
    }
    const messageId = await deps.recordSend(database, {
      familyId: input.familyId,
      parentUserId: recipient.parentUserId,
      channel: delivered.channel === 'imessage' ? 'imessage' : 'sms',
      category: 'registration_sequence',
      templateKey: input.templateKey,
      dedupeKey,
      status: acceptedStatus(delivered.channel === 'imessage' ? 'imessage' : 'sms'),
      providerMessageId: delivered.providerMessageId,
      providerChatId: delivered.chatId,
      sentAt: input.now,
    });
    await deps.audit(database, {
      familyId: input.familyId,
      actor: 'system',
      actionTaken: input.auditVerb,
      targetTable: 'channel_messages',
      targetId: messageId,
      after: input.auditAfter(recipient),
    });

    // THE THREAD, which is where THIS parent's answer will be read — their own, one per
    // recipient. Unconditional and AFTER the send: a leg that never reached a transport
    // is not something Hale said. The COMPOSED leg, never the wire body — the CASL line
    // belongs on the wire and nowhere else.
    await deps.threadMessage(database, {
      familyId: input.familyId,
      parentUserId: recipient.parentUserId,
      body: input.body,
    });
    if (promiseMessageId === null) promiseMessageId = messageId;
    wireProvider = { id: delivered.providerMessageId, chatId: delivered.chatId };
    sent += 1;
  }

  // The other seat shares the group bubble. Their dedupe key is consumed so the
  // next tick does not put the same leg in the group a second time. No second send.
  if (wireProvider && target.channel === 'group') {
    for (const shadow of shadowed) {
      await deps.recordSend(database, {
        familyId: input.familyId,
        parentUserId: shadow.recipient.parentUserId,
        channel: 'imessage',
        category: 'registration_sequence',
        templateKey: input.templateKey,
        dedupeKey: shadow.dedupeKey,
        status: acceptedStatus('imessage'),
        providerMessageId: wireProvider.id,
        providerChatId: wireProvider.chatId,
        sentAt: input.now,
      });
    }
  }

  return { sent, refused, promiseMessageId };
}

/** A change note's identity: one per parent per moved opening, ever. A page that moves
 * again owes a new note; one that flaps back to a date already noted owes none. */
export function dateMovedDedupeKey(
  familyId: string,
  windowId: string,
  opensAt: string,
  parentUserId: string,
): string {
  return `registration_date_moved:${familyId}:${windowId}:${opensAt}:${parentUserId}`;
}

/**
 * VIL-423 · tell a household, once, that the page moved an opening they were told.
 *
 * Only a seat that already received a dated leg for this window is owed one: everyone
 * else hears the new date from their next leg, which the moved anchor now schedules. The
 * change stays owed while a seat is held (quiet hours) or the text is unwritten, and is
 * cleared once every owed seat has it, or the new opening has passed.
 */
async function sendDateMovedNote(
  database: Database,
  sequence: CatalogSequence,
  deps: SequenceRunDeps,
  now: Date,
): Promise<LegTally> {
  const change = parsePendingChange(sequence.pendingChange);
  const settle = async () => {
    await deps.saveDateWatch(database, sequence.sequenceId, { pendingChange: null });
    sequence.pendingChange = null;
  };
  // The same condition `recheckDates` recorded the change under, re-read here because a
  // household can opt out or report an outcome between that tick and this one (CASL).
  const stopped =
    sequence.outcome !== null
      ? 'outcome_reported'
      : sequence.optIn !== 'opted_in' && sequence.optIn !== 'pending'
        ? 'not_opted_in'
        : null;
  if (stopped !== null) {
    await settle();
    await deps.audit(database, {
      familyId: sequence.familyId,
      actor: 'system',
      actionTaken: 'registration_date_moved_dropped',
      targetTable: 'registration_sequences',
      targetId: sequence.sequenceId,
      after: {
        windowId: sequence.window.id,
        outcome: 'registration_date_moved_dropped',
        reason: stopped,
      },
    });
    return emptyTally({ dropped: 1 });
  }
  if (change === null || Date.parse(change.to) <= now.getTime()) {
    await settle();
    return emptyTally();
  }

  const recipients = await deps.loadRecipients(database, sequence.familyId);
  const owed: Array<{ recipient: FamilyTextRecipient; dedupeKey: string }> = [];
  let deduped = 0;
  for (const recipient of recipients) {
    let told = false;
    for (const leg of DATED_LEGS) {
      const key = legDedupeKey(sequence.familyId, sequence.window.id, leg, recipient.parentUserId);
      if (await deps.dedupeActive(database, key)) {
        told = true;
        break;
      }
    }
    if (!told) continue;
    const dedupeKey = dateMovedDedupeKey(
      sequence.familyId,
      sequence.window.id,
      change.to,
      recipient.parentUserId,
    );
    if (await deps.dedupeActive(database, dedupeKey)) deduped += 1;
    else owed.push({ recipient, dedupeKey });
  }
  if (owed.length === 0) {
    await settle();
    return emptyTally({ deduped });
  }

  const allowed: Array<{ recipient: FamilyTextRecipient; dedupeKey: string; optOut: OptOutForm }> =
    [];
  const held: ProactiveHoldReason[] = [];
  for (const { recipient, dedupeKey } of owed) {
    const verdict = await assertProactiveSendAllowed(
      {
        familyId: sequence.familyId,
        parentUserId: recipient.parentUserId,
        kind: 'registration_sequence',
        now,
        urgent: false,
      },
      deps.buildGate(database),
    );
    if (verdict.allowed) allowed.push({ recipient, dedupeKey, optOut: verdict.optOut });
    else held.push(verdict.reason);
  }
  if (allowed.length === 0) return emptyTally({ deduped, held });

  const { isResidentWindow } = ladderAnchor(sequence, 'enforce');
  const opens = new Date(change.to);
  const match = matchForSequence(sequence, { isResidentWindow, opensForFamilyAt: opens });
  const children = await deps.loadChildren(database, sequence.familyId);
  const facts = dateMovedFacts({
    shortlist: buildShortlist(match, children, now) ?? windowShortlist(match),
    timeZone: sequence.timeZone,
    now,
    was: new Date(change.from),
    opens,
    opensTimePrinted: change.toTimePrinted,
  });
  const language = deps.client ? await deps.loadLanguage(database, sequence.familyId) : null;
  const written =
    deps.client && language
      ? await deps.composeDateMoved(deps.client, { ...facts, language }, sequence.familyId)
      : null;
  if (!written) {
    await deps.audit(database, {
      familyId: sequence.familyId,
      actor: 'system',
      actionTaken: 'registration_date_moved_unwritten',
      targetTable: 'registration_sequences',
      targetId: sequence.sequenceId,
      after: { windowId: sequence.window.id, outcome: 'registration_date_moved_unwritten' },
    });
    return { sent: 0, deduped, refused: 0, held, quiet: false, unwritten: 1 };
  }

  const { sent, refused } = await deliverHouseholdText(database, deps, {
    familyId: sequence.familyId,
    sequenceId: sequence.sequenceId,
    templateKey: 'registration_sequence:date_moved',
    body: dateMovedBody(written, sequence.window.sourceUrl),
    allowed,
    now,
    auditVerb: 'registration_date_moved_sent',
    auditAfter: (recipient) => ({
      windowId: sequence.window.id,
      municipality: sequence.window.municipality,
      cycleLabel: sequence.window.cycleLabel,
      role: recipient.role,
    }),
  });
  if (held.length === 0 && sent === allowed.length) await settle();
  return { sent, deduped, refused, held, quiet: false };
}

/**
 * VIL-423 · slice 4b — the scheduled re-read of each watched page (recheck.ts), before
 * any leg is decided, so a moved opening moves this tick's legs too. Only a ladder whose
 * opening comes from the catalog row: a bound course is read off its own page at the
 * evening and go legs. Shadow logs what it found and stores only when to read next.
 */
async function recheckDates(
  database: Database,
  sequences: readonly CatalogSequence[],
  deps: SequenceRunDeps,
  mode: Exclude<DateCheckMode, 'off'>,
  createReader: () => RegistrationReader | null,
  result: SequenceRunResult,
  now: Date,
): Promise<void> {
  const subjects: RecheckSubject[] = [];
  for (const sequence of sequences) {
    if (sequence.courseOpensAt !== null || sequence.outcome !== null) continue;
    if (sequence.optIn !== 'opted_in' && sequence.optIn !== 'pending') continue;
    const { isResidentWindow, anchor } = ladderAnchor(sequence, mode);
    if (anchor.getTime() <= now.getTime()) continue;
    subjects.push({
      sequenceId: sequence.sequenceId,
      window: sequence.window,
      resident: isResidentWindow,
      anchor,
      nextCheckAt: sequence.nextCheckAt,
      pendingChange: parsePendingChange(sequence.pendingChange),
    });
  }
  const { results, reads } = await recheckWatchedDates(subjects, createReader, mode, now);
  result.recheckReads = reads;
  const byId = new Map(sequences.map((sequence) => [sequence.sequenceId, sequence]));
  for (const { subject, outcome, reason, detail, patch } of results) {
    result.dateRecheck[outcome] += 1;
    console.info(
      {
        outcome: 'registration_date_recheck',
        mode,
        sequenceId: subject.sequenceId,
        windowId: subject.window.id,
        check: outcome,
        reason,
        detail,
      },
      'registration date recheck',
    );
    const sequence = byId.get(subject.sequenceId);
    if (!sequence || Object.keys(patch).length === 0) continue;
    try {
      await deps.saveDateWatch(database, subject.sequenceId, patch);
      if (patch.lastReading) sequence.lastReading = { ...patch.lastReading };
      if (patch.nextCheckAt) sequence.nextCheckAt = patch.nextCheckAt;
      if (patch.pendingChange !== undefined) {
        sequence.pendingChange = patch.pendingChange === null ? null : { ...patch.pendingChange };
      }
      if (outcome === 'moved' && patch.lastReading) {
        await deps.audit(database, {
          familyId: sequence.familyId,
          actor: 'system',
          actionTaken: 'registration_date_moved',
          targetTable: 'registration_sequences',
          targetId: sequence.sequenceId,
          after: {
            windowId: sequence.window.id,
            from: subject.anchor.toISOString(),
            to: patch.lastReading.openAt,
          },
        });
      }
    } catch (err) {
      result.failed += 1;
      console.error(
        { err, sequenceId: subject.sequenceId },
        'registration sequence: date recheck save failed',
      );
    }
  }
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

/**
 * The evening text, or null. Null is nothing sent. A missing client is named
 * here; a model miss is named inside the composer.
 */
async function writeEvening(
  database: Database,
  deps: SequenceRunDeps,
  familyId: string,
  facts: EveningFacts,
): Promise<string | null> {
  if (!deps.client) {
    console.error(
      { familyId, outcome: 'registration_evening_unwritten', reason: 'client_unavailable' },
      'registration sequence: evening text unwritten, nothing sent',
    );
    return null;
  }
  const language = await deps.loadLanguage(database, familyId);
  return deps.composeEvening(deps.client, { ...facts, language }, familyId);
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
    sequence: CatalogSequence;
    shortlist: Shortlist;
    leg: SequenceLeg;
    messageId: string;
    /** The instant the ladder is running on — the bound course's clock where there is
     * one, so a promise's deadline moves with the morning it is about. */
    anchor: Date;
    /** THIS tick's reading of the bound course, where one happened. */
    prep: PrepVerdict | null;
    /** False when the leg went out as the date-unconfirmed text, which promises no plan. */
    promisedPlan: boolean;
  },
  deps: SequenceRunDeps,
  now: Date,
): Promise<void> {
  const { sequence, leg, messageId } = args;
  if (leg === 'heads_up' && headsUpPromisesPlan(sequence.optIn)) {
    if (!args.promisedPlan) return;
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
  sequence: CatalogSequence,
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

/**
 * The instant a catalog ladder runs on. THIS family's open, not the general one: a
 * resident household in a town that publishes a head start registers a week early. The
 * course page's own clock where the parent has bound one; else, under `enforce`, the
 * opening the scheduled re-read last saw on the window's page (recheck.ts), so a page
 * that moved its date moves every unsent leg; else the M1 row's family-open instant.
 */
function ladderAnchor(
  sequence: CatalogSequence,
  mode: DateCheckMode,
): { isResidentWindow: boolean; anchor: Date } {
  const { isResidentWindow, opensForFamilyAt } = resolveFamilyOpen(
    sequence.window,
    sequence.areaCoarse,
  );
  const seen =
    mode === 'enforce'
      ? lastSeenOpenAt(sequence.lastReading, sequence.window, isResidentWindow)
      : null;
  return { isResidentWindow, anchor: sequence.courseOpensAt ?? seen ?? opensForFamilyAt };
}

type LinkWatchFate = { kind: 'undated' } | { kind: 'quiet' } | { kind: 'unread'; leg: SequenceLeg };

/**
 * A watch a parent's link created (VIL-423), evaluated without any I/O. No leg is sent
 * for one yet: the only send-time reads are a catalog portal's, so its stored
 * `course_opens_at` cannot be re-read before a text would speak it, and Hale holds no
 * name for it that the heads-up composer would accept. Slice 7b lifts this.
 *
 * A paste is not consent, so only an approved watch can have a leg due at all. No
 * waitlist clock and no portal are invented for it.
 */
function linkWatchFate(sequence: LiveSequence, now: Date): LinkWatchFate {
  if (sequence.courseOpensAt === null) return { kind: 'undated' };
  if (sequence.optIn !== 'opted_in') return { kind: 'quiet' };
  const leg = dueLeg(
    {
      openAt: sequence.courseOpensAt,
      timeZone: sequence.timeZone,
      optIn: sequence.optIn,
      outcome: sequence.outcome,
      waitlistStartedAt: sequence.waitlistStartedAt,
      waitlistResponseHours: null,
      portal: null,
    },
    now,
  );
  return leg === null ? { kind: 'quiet' } : { kind: 'unread', leg };
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
  // On Preview, only allowlisted test families (no-op elsewhere).
  const armed = (family: { familyId: string }) =>
    familyInPreviewScope(family.familyId) && (allFamilies || allowlist.has(family.familyId));

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
  const live = (await deps.loadLiveSequences(database, now)).filter(armed);
  // Split BEFORE the cap: a link watch costs no I/O, so it must not take a slot a dated
  // catalog ladder needs.
  // Copies: the date re-read below updates this tick's view of a ladder it rescheduled.
  const sequences = live
    .filter((sequence): sequence is CatalogSequence => sequence.window !== null)
    .slice(0, MAX_SEQUENCE_FAMILIES_PER_RUN)
    .map((sequence) => ({ ...sequence }));
  const linkWatches = live.filter((sequence) => sequence.window === null);

  const undatedIds: string[] = [];
  const unread: Array<{ sequenceId: string; leg: SequenceLeg }> = [];
  for (const sequence of linkWatches) {
    result.evaluated += 1;
    try {
      const fate = linkWatchFate(sequence, now);
      if (fate.kind === 'undated') undatedIds.push(sequence.sequenceId);
      else if (fate.kind === 'quiet') result.quiet += 1;
      else unread.push({ sequenceId: sequence.sequenceId, leg: fate.leg });
    } catch (err) {
      result.failed += 1;
      console.error({ err, sequenceId: sequence.sequenceId }, 'registration sequence: leg failed');
    }
  }
  result.undated = undatedIds.length;
  result.linkUnread = unread.length;
  if (undatedIds.length > 0) {
    console.info(
      { outcome: 'registration_link_watch_undated', sequenceIds: undatedIds },
      'registration sequence: link watches with no open date, no leg',
    );
  }
  if (unread.length > 0) {
    console.info(
      { outcome: 'registration_link_watch_unread', watches: unread },
      'registration sequence: link-watch legs due and held, nothing sent',
    );
  }

  // ONE reader for the whole phase, because the budget and the page cache are both
  // properties of the RUN: two households on one course cost one GET, and the wall clock
  // starts when the leg phase does rather than when the process did.
  const reader = courseReader(deps.fetchBody, Date.now());
  // ONE page reader for the re-read and the send-time check, so a page the re-read just
  // read costs nothing more when a leg states its date on the same tick.
  let dateReader: RegistrationReader | null | undefined;
  const sharedDateReader = () => {
    if (dateReader === undefined) dateReader = deps.createDateReader();
    return dateReader;
  };
  const checker = createDateChecker(sharedDateReader);
  if (checker.mode !== 'off') {
    try {
      await recheckDates(database, sequences, deps, checker.mode, sharedDateReader, result, now);
    } catch (err) {
      result.failed += 1;
      console.error({ err }, 'registration sequence: date recheck failed');
    }
  }
  for (const sequence of sequences) {
    result.evaluated += 1;
    try {
      if (checker.mode === 'enforce' && sequence.pendingChange !== null) {
        const note = await sendDateMovedNote(database, sequence, deps, now);
        result.dateMovedSent += note.sent;
        result.dateMovedDropped += note.dropped ?? 0;
        result.deduped += note.deduped;
        result.refused += note.refused;
        result.unwritten += note.unwritten ?? 0;
        for (const reason of note.held) result.held[reason] += 1;
      }
      const outcome = await runLegForSequence(database, sequence, deps, reader, checker, now);
      if (outcome.prep) result.prep[outcome.prep] += 1;
      if (outcome.anchorMoved) result.prep.anchor_moved += 1;
      if (outcome.noFit) result.noFit += 1;
      // The reading is per SEQUENCE (one course page, one leg) and the sending is per
      // RECIPIENT, so the two are added differently and deliberately.
      if (outcome.skipped) result.skipped[outcome.skipped] += 1;
      if (outcome.quiet) result.quiet += 1;
      result.unwritten += outcome.unwritten ?? 0;
      result.sent += outcome.sent;
      result.deduped += outcome.deduped;
      result.refused += outcome.refused;
      for (const reason of outcome.held) result.held[reason] += 1;
    } catch (err) {
      // One family's bad data must not silence every family after it.
      result.failed += 1;
      console.error({ err, sequenceId: sequence.sequenceId }, 'registration sequence: leg failed');
    }
  }
  result.dateCheck = { ...checker.tally };
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
      lastReading: schema.registrationSequences.lastReading,
      nextCheckAt: schema.registrationSequences.nextCheckAt,
      pendingChange: schema.registrationSequences.pendingChange,
      actionId: schema.registrationSequences.actionId,
      executedAt: schema.actions.executedAt,
      revertedAt: schema.actions.revertedAt,
      window: schema.registrationWindows,
      timeZone: schema.users.timezone,
      areaCoarse: schema.families.areaCoarse,
    })
    .from(schema.registrationSequences)
    // LEFT: a watch a parent's link created has no catalog row (VIL-423). The FK
    // cascades, so a null window here means exactly `window_id IS NULL`.
    .leftJoin(
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
    lastReading: row.lastReading,
    nextCheckAt: row.nextCheckAt,
    pendingChange: row.pendingChange,
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
          target: [schema.registrationSequences.familyId, schema.registrationSequences.windowId],
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
    loadRecipients: (database, familyId) => loadFamilyTextRecipients(database, familyId),
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
    transport: createOutboundTransport(),
    recordCommitment,
    fulfillCommitment,
    threadMessage: threadProactiveMessage,
    // The bare GET: no cookie, no User-Agent, no Referer, `redirect: 'error'`, a status
    // throw and a 4 MB ceiling. Six seconds, because this read happens inside a leg
    // whose interval is fifteen minutes wide.
    fetchBody: createFetchBody(GO_FETCH_TIMEOUT_MS),
    client: voiceClient(),
    loadLanguage: familyLanguage,
    composeEvening: composeRegistrationEvening,
    composeMorning: composeRegistrationMorning,
    composeHeadsUp: composeRegistrationHeadsUp,
    writeNote: registrationNoteWriter(),
    createDateReader: liveDateReader,
    composeDateUnconfirmed,
    saveDateWatch: async (database, sequenceId, patch) => {
      await database
        .update(schema.registrationSequences)
        .set({
          ...(patch.lastReading === undefined ? {} : { lastReading: { ...patch.lastReading } }),
          ...(patch.lastReadAt === undefined ? {} : { lastReadAt: patch.lastReadAt }),
          ...(patch.nextCheckAt === undefined ? {} : { nextCheckAt: patch.nextCheckAt }),
          ...(patch.pendingChange === undefined
            ? {}
            : { pendingChange: patch.pendingChange === null ? null : { ...patch.pendingChange } }),
          updatedAt: new Date(),
        })
        .where(eq(schema.registrationSequences.id, sequenceId));
    },
    composeDateMoved,
    refreshCourseAnchor: async (database, input) => {
      const [row] = await database
        .update(schema.registrationSequences)
        .set({ courseOpensAt: input.courseOpensAt, updatedAt: input.now })
        .where(
          and(
            eq(schema.registrationSequences.id, input.sequenceId),
            // The page the clock came from, still the page the row holds.
            eq(schema.registrationSequences.courseUrl, input.courseUrl),
            sql`${schema.registrationSequences.courseOpensAt} is distinct from ${input.courseOpensAt}`,
          ),
        )
        .returning({ id: schema.registrationSequences.id });
      return row !== undefined;
    },
  };
}
