import {
  type Database,
  type RegistrationSourceState,
  registrationSourceState,
  schema,
} from '@hale/db';
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import {
  type FamilyTextRecipient,
  loadFamilyTextRecipients,
} from '~/lib/channel/family-recipients';
import type { ChannelTransport } from '~/lib/channel/intake/transport';
import { type AcceptedStatus, acceptedStatus, dedupeActive } from '~/lib/channel/ledger';
import {
  deliverFamilyOutbound,
  familyOutboundTarget,
  householdCopies,
  notePermanentSkip,
} from '~/lib/channel/linq/family-outbound';
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
import { type SpotPortal, portalForMunicipality, sanitizeSpotUrl } from '~/lib/channel/spots/url';
import { threadProactiveMessage } from '~/lib/channel/thread';
import { resolveSendablePhone } from '~/lib/channels/sms-consent-core';
import { draftInlineAction } from '~/lib/coach/inline-action';
import { fulfillCommitment, recordCommitment } from '~/lib/commitments/ledger';
import { pipelineClient } from '~/lib/pipeline/client';
import { type FetchPage, createFetchBody, pageCache } from '~/lib/registration/fetch';
import {
  type RegistrationMatch,
  resolveFamilyOpen,
} from '~/lib/registration/match-registration-windows';
import type { LiveRegistrationReading } from '../live-reading';
import {
  type RegistrationReader,
  type RegistrationTarget,
  createRegistrationReader,
  registrationDate,
  registrationHasOpened,
  windowReadTarget,
} from '../read';
import { composeRegistrationReminder } from './compose';
import { headsUpPromisesPlan, windowPhrase } from './copy.js';
import {
  GO_FETCH_TIMEOUT_MS,
  type PrepInput,
  type PrepVerdict,
  READ_WALL_BUDGET_MS,
  readCoursePrep,
} from './prepare.js';
import {
  type RegistrationChange,
  claimDueRegistrationChecks,
  claimRegistrationSend,
  refreshRegistrationWatch,
  registrationChange,
  registrationChangeBody,
  releaseRegistrationSend,
} from './refresh';
import {
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
  courseShortlist,
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
 * Only existing family-owned watches are refreshed and delivered. The source page is
 * re-read on scheduled checks and again before an unsent, consent-gated reminder.
 * No global seasonal catalog is scanned to create new watches.
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

/** Bound the watch work performed in a single cron tick. */
const MAX_SEQUENCE_FAMILIES_PER_RUN = 100;

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
  /** Imported watch-owned metadata; a fresh read owns every parent-facing date. */
  window: RegistrationSourceState | null;
  /** Read live off the approval spine — see registration-sequences.ts. */
  optIn: SequenceOptIn;
  outcome: RegistrationOutcome | null;
  waitlistPosition: number | null;
  waitlistStartedAt: Date | null;
  /** VIL-338 · the course page the parent pasted, exactly as `sanitizeSpotUrl` rebuilt
   * it, or null while nothing is bound. All opening reminders re-read their source, including unbound imported watches. */
  courseUrl: string | null;
  /** THE ANCHOR when a course is bound: the instant that page says it opens for THIS
   * family. Every interval and every sentence is derived from it, so a bind that moves
   * the morning moves the ladder. Null and non-null together with `courseUrl` — the
   * row's own CHECK constraint. */
  courseOpensAt: Date | null;
  /** What the parent TOLD Hale about their portal setup. Never inferred, never
   * verified; null is "unasked or unanswered", which the copy says in those words. */
  readinessReady: boolean | null;
  lastReading?: Record<string, unknown> | null;
  pendingChange?: RegistrationChange | null;
  pausedAt?: Date | null;
  dateReviewActionId?: string | null;
}

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
  compose: typeof composeRegistrationReminder;
  /** Required even in fixtures: a cached scheduling anchor can never authorize a send. */
  live: {
    read: RegistrationReader;
    readForSend: RegistrationReader;
    claimDue: typeof claimDueRegistrationChecks;
    refresh: typeof refreshRegistrationWatch;
    reload(database: Database, sequenceId: string): Promise<LiveSequence | null>;
    claimSend: typeof claimRegistrationSend;
    releaseSend: typeof releaseRegistrationSend;
    draftReview(database: Database, sequence: LiveSequence): Promise<void>;
    acknowledgeChange(database: Database, sequence: LiveSequence): Promise<void>;
  };
  loadChildren(database: Database, familyId: string): Promise<SequenceChild[]>;
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
}

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
 */
export type SequenceSkipReason = 'open_time_unpublished';

const SKIP_REASONS: readonly SequenceSkipReason[] = ['open_time_unpublished'];

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

// ── run the legs ────────────────────────────────────────────────────

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
  initialSequence: LiveSequence,
  deps: SequenceRunDeps,
  reader: CourseReader,
  now: Date,
): Promise<LegTally> {
  let sequence = initialSequence;
  const sendStartedAt = Date.now();
  // THIS family's open instant, not the general one. A resident household in a town
  // that publishes a head start registers a week early, and a ladder anchored on the
  // general date would tap them on the shoulder days after their doors had opened.
  const { isResidentWindow, opensForFamilyAt } = sequence.window
    ? resolveFamilyOpen(sequence.window, sequence.areaCoarse)
    : { isResidentWindow: false, opensForFamilyAt: sequence.courseOpensAt ?? now };
  // THE ANCHOR. The course page's own clock where the parent has bound one, and the M1
  // row's family-open instant otherwise. Fed to `dueLeg`, to every interval and to the
  // copy from this ONE place, so the morning the ladder is scheduled on and the morning
  // its sentences name can never be two different instants.
  let anchor = sequence.courseOpensAt ?? opensForFamilyAt;
  // From the registry, never from the row: a municipality Hale has learned to read is a
  // code fact, and it is what lights the readiness leg and the two send-time reads.
  const portal = sequence.window ? portalForMunicipality(sequence.window.municipality) : null;
  const notice =
    sequence.pendingChange && !sequence.pendingChange.notified ? sequence.pendingChange : null;
  if (notice && (sequence.optIn === 'missing' || sequence.optIn === 'declined'))
    return emptyTally({ quiet: true });
  const leg = notice
    ? ('heads_up' as const)
    : dueLeg(
        {
          openAt: anchor,
          timeZone: sequence.timeZone,
          optIn: sequence.optIn,
          outcome: sequence.outcome,
          waitlistStartedAt: sequence.waitlistStartedAt,
          waitlistResponseHours: sequence.window?.waitlistResponseHours ?? null,
          portal,
        },
        now,
      );
  if (leg === null) return emptyTally({ quiet: true });
  // A reported waitlist offer has its own clock, independent of registration opening.
  const waitlistLeg = leg === 'waitlist_half' || leg === 'waitlist_final';
  if (!notice && !waitlistLeg && (sequence.pausedAt || !sequence.courseOpensAt))
    return emptyTally({ quiet: true });
  let reading: LiveRegistrationReading;
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
      notice
        ? `${sequence.sequenceId}:change:${notice.key}`
        : (sequence.window?.id ?? sequence.sequenceId),
      leg,
      recipient.parentUserId,
    );
    if (await deps.dedupeActive(database, dedupeKey)) deduped += 1;
    else pending.push({ recipient, dedupeKey });
  }
  if (pending.length === 0) {
    if (notice && deps.live) await deps.live.acknowledgeChange(database, sequence);
    return emptyTally({ deduped });
  }

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
        urgent: !notice && legIsUrgent(leg),
      },
      deps.buildGate(database),
    );
    if (verdict.allowed) allowed.push({ recipient, dedupeKey, optOut: verdict.optOut });
    else held.push(verdict.reason);
  }
  if (allowed.length === 0) return emptyTally({ deduped, held });

  {
    // Only an unsent, gated message reads again; ordinary five-minute scans do not.
    reading = await deps.live.readForSend(registrationTargetFor(sequence), now);
    const recorded = await deps.live.refresh(database, {
      sequenceId: sequence.sequenceId,
      reading,
      resident: isResidentWindow,
      now,
      cachedAnchor: sequence.courseOpensAt ?? (sequence.window ? opensForFamilyAt : null),
      parentTimeZone: sequence.timeZone,
    });
    if (!recorded) return emptyTally({ quiet: true });
    const fresh = await deps.live.reload(database, sequence.sequenceId);
    if (!fresh) return emptyTally({ quiet: true });
    if (fresh.optIn === 'declined' || fresh.optIn === 'missing') return emptyTally({ quiet: true });
    if (notice) {
      if (fresh.pendingChange?.key !== notice.key) return emptyTally({ quiet: true });
    } else {
      if (
        !waitlistLeg &&
        (fresh.pausedAt ||
          !fresh.courseOpensAt ||
          (fresh.pendingChange && !fresh.pendingChange.notified))
      )
        return emptyTally({ quiet: true });
      anchor = fresh.courseOpensAt ?? anchor;
      const currentLeg = dueLeg(
        {
          openAt: anchor,
          timeZone: fresh.timeZone,
          optIn: fresh.optIn,
          outcome: fresh.outcome,
          waitlistStartedAt: fresh.waitlistStartedAt,
          waitlistResponseHours: fresh.window?.waitlistResponseHours ?? null,
          portal,
        },
        now,
      );
      // A changed phase needs a new dedupe key and gate on the next tick.
      if (currentLeg !== leg) return emptyTally({ quiet: true });
      const publishedDate = registrationDate(reading, isResidentWindow);
      if (
        publishedDate?.time == null &&
        (leg === 'go' ||
          (leg === 'check_in' &&
            (!publishedDate || !registrationHasOpened(reading, publishedDate, now))))
      )
        return emptyTally({ skipped: 'open_time_unpublished' });
    }
    sequence = fresh;
  }

  const children = await deps.loadChildren(database, sequence.familyId);
  const match = sequence.window
    ? matchForSequence(sequence, { isResidentWindow, opensForFamilyAt: anchor })
    : null;
  // A course this family picked, on a portal Hale can read. Kept as ONE narrowed value
  // rather than a boolean, so nothing below can reach for a URL or a portal the
  // condition has not proved is there.
  const bound =
    sequence.courseUrl !== null && portal !== null && sanitizeSpotUrl(sequence.courseUrl).ok
      ? { url: sequence.courseUrl, portal }
      : null;
  // The two legs that SPEAK about the bound course, and therefore the only two that read
  // its page. Every other leg is about the municipal window and needs no network.
  const boundCourse = leg === 'battle_plan' || leg === 'go' ? bound : null;
  const fitted = match ? buildShortlist(match, children, now) : null;
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
  const boundSpeaks =
    sequence.window === null ||
    notice !== null ||
    (bound !== null && leg !== 'heads_up' && leg !== 'readiness');
  if (fitted === null && !boundSpeaks) return emptyTally({ quiet: true, deduped, held });
  const shortlist = fitted ?? (match ? windowShortlist(match) : urlShortlist(sequence, anchor));
  const effects: LegReadEffects = fitted === null ? { noFit: true } : {};

  let prep: { verdict: PrepVerdict; courseUrl: string } | null = null;
  if (boundCourse !== null && !notice) {
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
    if (moved !== null && moved.getTime() !== anchor.getTime()) return emptyTally({ quiet: true });
  } else if (portal !== null && (leg === 'battle_plan' || leg === 'go')) {
    // A morning leg for a household whose town Hale can read, with nothing pasted: the
    // trail should say so in a word, or this row and a no-portal town's are the same row.
    effects.prep = 'unbound';
  }

  const copyInput = {
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
          : waitlistDeadline(
              sequence.waitlistStartedAt,
              sequence.window?.waitlistResponseHours ?? null,
            ),
    },
  };
  const body = await deps.compose({
    leg,
    reading,
    resident: isResidentWindow,
    copy: copyInput,
    change: notice,
  });
  if (!body) throw new Error('registration reminder: writer unavailable or ungrounded');

  // ONE COMPOSED LEG, TWO ENVELOPES. The sentence is about the household's morning and
  // is rendered once, on the LADDER's clock (the sequence row's), so both parents read
  // the same time for the same registration. Each recipient still has their own
  // consent and dedupe gates; no opt-out footer is appended.
  let sent = 0;
  let refused = 0;
  let wireProvider: { id: string; chatId: string | null } | null = null;
  const target = await familyOutboundTarget(database, sequence.familyId);
  const wireCopies = householdCopies(target, allowed);
  const shadowed = target.channel === 'group' ? allowed.slice(wireCopies.length) : [];
  /** The row a family-scoped promise is opened and discharged against — the first leg
   * that actually left, in the reader's stable primary-parent-first order. */
  let promiseMessageId: string | null = null;

  for (const { recipient, dedupeKey, optOut } of wireCopies) {
    {
      const latest = await deps.live.reload(database, sequence.sequenceId);
      const sendNow = new Date(now.getTime() + Date.now() - sendStartedAt);
      if (
        !latest ||
        latest.optIn === 'declined' ||
        latest.optIn === 'missing' ||
        latest.courseUrl !== sequence.courseUrl ||
        (notice
          ? latest.pendingChange?.key !== notice.key
          : !waitlistLeg &&
            (latest.pausedAt || latest.courseOpensAt?.getTime() !== anchor.getTime()))
      )
        return emptyTally({ quiet: true });
      if (
        !notice &&
        dueLeg(
          {
            openAt: anchor,
            timeZone: latest.timeZone,
            optIn: latest.optIn,
            outcome: latest.outcome,
            waitlistStartedAt: latest.waitlistStartedAt,
            waitlistResponseHours: latest.window?.waitlistResponseHours ?? null,
            portal,
          },
          sendNow,
        ) !== leg
      )
        return emptyTally({ quiet: true });
      const gate = await assertProactiveSendAllowed(
        {
          familyId: sequence.familyId,
          parentUserId: recipient.parentUserId,
          kind: 'registration_sequence',
          urgent: !notice && legIsUrgent(leg),
          now: sendNow,
        },
        deps.buildGate(database),
      );
      if (!gate.allowed) {
        held.push(gate.reason);
        continue;
      }
    }
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
    const wireBody = withOptOut(body, optOut);
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
      refused += 1;
      continue;
    }

    const delivered = await deliverFamilyOutbound(database, {
      familyId: sequence.familyId,
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
        { sequenceId: sequence.sequenceId, code: delivered.reason },
        'registration sequence: outbound skipped',
      );
      if (delivered.reason !== 'not_configured') {
        await notePermanentSkip(database, {
          familyId: sequence.familyId,
          parentUserId: recipient.parentUserId,
          category: 'registration_sequence',
          templateKey: `registration_sequence:${leg}`,
          dedupeKey,
          reason: delivered.reason,
          now,
        });
      }
      continue;
    }
    const messageId = await deps.recordSend(database, {
      familyId: sequence.familyId,
      parentUserId: recipient.parentUserId,
      channel: delivered.channel === 'imessage' ? 'imessage' : 'sms',
      category: 'registration_sequence',
      templateKey: `registration_sequence:${leg}`,
      dedupeKey,
      status: acceptedStatus(delivered.channel === 'imessage' ? 'imessage' : 'sms'),
      providerMessageId: delivered.providerMessageId,
      providerChatId: delivered.chatId,
      sentAt: now,
    });
    await deps.audit(database, {
      familyId: sequence.familyId,
      actor: 'system',
      actionTaken: 'registration_sequence_leg_sent',
      targetTable: 'channel_messages',
      targetId: messageId,
      // Enum-shaped provenance only, never the rendered body (rule #1). The three
      // VIL-338 fields are the whole receipt for a send-time read: WHICH sentence the
      // page earned, how far the page's clock sat from the anchor, and whether the
      // anchor was moved. The M1 row's own disagreement rides here rather than in an
      // audit verb of its own — a fact about public reference data is not an event in a
      // family's history.
      after: {
        leg,
        windowId: sequence.window?.id ?? null,
        municipality: sequence.window?.municipality ?? null,
        cycleLabel: sequence.window?.cycleLabel ?? null,
        urgent: legIsUrgent(leg),
        // Which SEAT this copy went to. The row already names the parent; this names
        // the relationship, which is what a founder reading the trail is asking.
        role: recipient.role,
        // `prep` alone on the leg that had a portal and nothing bound: there was no
        // read, so there is no drift to report and no anchor that could have moved.
        ...(effects.prep === undefined ? {} : { prep: effects.prep }),
        ...(prep === null
          ? {}
          : {
              driftMinutes: driftOf(prep.verdict),
              anchorMovedMinutes: effects.anchorMoved === true ? driftOf(prep.verdict) : null,
            }),
      },
    });

    // THE THREAD, which is where THIS parent's answer will be read — their own, one per
    // recipient. Unconditional and AFTER the send: a leg that never reached a transport
    // is not something Hale said. The COMPOSED leg, never the wire body — the CASL line
    // belongs on the wire and nowhere else.
    await deps.threadMessage(database, {
      familyId: sequence.familyId,
      parentUserId: recipient.parentUserId,
      body,
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
        familyId: sequence.familyId,
        parentUserId: shadow.recipient.parentUserId,
        channel: 'imessage',
        category: 'registration_sequence',
        templateKey: `registration_sequence:${leg}`,
        dedupeKey: shadow.dedupeKey,
        status: acceptedStatus('imessage'),
        providerMessageId: wireProvider.id,
        providerChatId: wireProvider.chatId,
        sentAt: now,
      });
    }
  }

  // MEM-10 · ONCE PER LEG, not once per number. The promise is the HOUSEHOLD's — "I'll
  // send your plan the evening before" is one plan — so a second recordCommitment would
  // report a debt Hale does not owe, and a second fulfillCommitment would close a
  // promise that was never opened twice.
  if (notice && (sent > 0 || deduped > 0) && held.length === 0 && refused === 0) {
    await deps.live.acknowledgeChange(database, sequence);
  }
  if (!notice && promiseMessageId !== null) {
    await recordLegPromise(
      database,
      {
        sequence,
        shortlist,
        leg,
        messageId: promiseMessageId,
        anchor,
        prep: prep?.verdict ?? null,
      },
      deps,
      now,
    );
  }
  return { sent, deduped, refused, held, quiet: false, ...effects };
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
  if (!sequence.window) throw new Error('registration: URL watch has no window match');
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

export function registrationTargetFor(sequence: LiveSequence): RegistrationTarget {
  if (
    sequence.window &&
    (sequence.courseUrl === null || sequence.courseUrl === sequence.window.sourceUrl)
  )
    return windowReadTarget(sequence.window);
  if (!sequence.courseUrl) throw new Error('registration: missing watch target');
  return {
    municipality: new URL(sequence.courseUrl).hostname,
    programDomain: 'course',
    cycleLabel: 'the single course shown on this page',
    sourceUrl: sequence.courseUrl,
    timeZone:
      typeof sequence.lastReading?.timeZone === 'string' ? sequence.lastReading.timeZone : null,
  };
}

function urlShortlist(sequence: LiveSequence, anchor: Date): Shortlist {
  if (!sequence.courseUrl) throw new Error('registration: missing URL');
  return courseShortlist(sequence.sequenceId, sequence.courseUrl, anchor);
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

  const startedAt = Date.now();
  {
    const due = new Set(await deps.live.claimDue(database, now));
    for (const sequenceId of due) {
      if (Date.now() - startedAt > 120_000) break;
      try {
        const watch = await deps.live.reload(database, sequenceId);
        if (!watch) continue;
        const reading = await deps.live.read(registrationTargetFor(watch), now);
        const open = watch.window ? resolveFamilyOpen(watch.window, watch.areaCoarse) : null;
        await deps.live.refresh(database, {
          sequenceId: watch.sequenceId,
          reading,
          resident: open?.isResidentWindow ?? false,
          cachedAnchor: watch.courseOpensAt ?? open?.opensForFamilyAt ?? null,
          parentTimeZone: watch.timeZone,
          now,
        });
      } catch {
        result.failed += 1;
        console.error({ sequenceId }, 'registration refresh failed');
      }
    }
  }

  // ── Run existing, parent-owned watches ───────────────────────────────────────────────────
  const sequences = (await deps.loadLiveSequences(database, now))
    .filter(armed)
    .slice(0, MAX_SEQUENCE_FAMILIES_PER_RUN);

  // ONE reader for the whole phase, because the budget and the page cache are both
  // properties of the RUN: two households on one course cost one GET, and the wall clock
  // starts when the leg phase does rather than when the process did.
  const reader = courseReader(deps.fetchBody, Date.now());
  for (const sequence of sequences) {
    if (Date.now() - startedAt > 240_000) break;
    result.evaluated += 1;
    let lease: number | null = null;
    try {
      lease = await deps.live.claimSend(
        database,
        sequence.sequenceId,
        new Date(now.getTime() + Date.now() - startedAt),
      );
      if (lease === null) {
        result.quiet += 1;
        continue;
      }
      await deps.live.draftReview(database, sequence);
      if (Date.now() - startedAt > 210_000) continue;
      const current = await deps.live.reload(database, sequence.sequenceId);
      if (!current) continue;
      const outcome = await runLegForSequence(database, current, deps, reader, now);
      if (outcome.prep) result.prep[outcome.prep] += 1;
      if (outcome.anchorMoved) result.prep.anchor_moved += 1;
      if (outcome.noFit) result.noFit += 1;
      // The reading is per SEQUENCE (one course page, one leg) and the sending is per
      // RECIPIENT, so the two are added differently and deliberately.
      if (outcome.skipped) result.skipped[outcome.skipped] += 1;
      if (outcome.quiet) result.quiet += 1;
      result.sent += outcome.sent;
      result.deduped += outcome.deduped;
      result.refused += outcome.refused;
      for (const reason of outcome.held) result.held[reason] += 1;
    } catch (err) {
      // One family's bad data must not silence every family after it.
      result.failed += 1;
      console.error({ err, sequenceId: sequence.sequenceId }, 'registration sequence: leg failed');
    } finally {
      if (lease !== null) await deps.live.releaseSend(database, sequence.sequenceId, lease);
    }
  }
  result.read = reader.tally.read;
  result.readSkipped = reader.tally.skipped;
  return result;
}

// ── prod wiring ──────────────────────────────────────────────────────────────

/**
 * Every sequence that could still have a leg due: no outcome yet, or waitlisted (whose
 * guards are still ahead of it). A registered or missed window is finished.
 *
 * The opt-in is derived in the SAME query, from the approval spine's own columns, so
 * the leg phase costs one read for every sequence rather than one per sequence.
 */
export async function loadLiveSequences(
  database: Database,
  sequenceId?: string,
  familyId?: string,
  now?: Date,
): Promise<LiveSequence[]> {
  const enabledFamilies = [...f14Allowlist()];
  let query = database
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
      pendingChange: schema.registrationSequences.pendingChange,
      pausedAt: schema.registrationSequences.pausedAt,
      dateReviewActionId: schema.registrationSequences.dateReviewActionId,
      actionId: schema.registrationSequences.actionId,
      executedAt: schema.actions.executedAt,
      revertedAt: schema.actions.revertedAt,
      window: schema.registrationSequences.sourceContext,
      timeZone: schema.users.timezone,
      areaCoarse: schema.families.areaCoarse,
    })
    .from(schema.registrationSequences)
    .innerJoin(schema.users, eq(schema.users.id, schema.registrationSequences.parentUserId))
    .innerJoin(schema.families, eq(schema.families.id, schema.registrationSequences.familyId))
    .leftJoin(schema.actions, eq(schema.actions.id, schema.registrationSequences.actionId))
    .where(
      and(
        sequenceId ? eq(schema.registrationSequences.id, sequenceId) : undefined,
        familyId ? eq(schema.registrationSequences.familyId, familyId) : undefined,
        now && !f14Enabled()
          ? enabledFamilies.length
            ? inArray(schema.registrationSequences.familyId, enabledFamilies)
            : sql`false`
          : undefined,
        now
          ? sql`(${schema.registrationSequences.pendingChange}->>'notified' = 'false'
        or (${schema.registrationSequences.pendingChange}->>'kind' = 'later' and ${schema.registrationSequences.dateReviewActionId} is null)
        or ${schema.registrationSequences.outcome} = 'waitlisted'
        or coalesce(${schema.registrationSequences.courseOpensAt}, (${schema.registrationSequences.sourceContext}->>'openAt')::timestamptz) between ${new Date(now.getTime() - 76 * 3_600_000)} and ${new Date(now.getTime() + 7 * 86_400_000)})`
          : undefined,
        or(
          isNull(schema.registrationSequences.outcome),
          eq(schema.registrationSequences.outcome, 'waitlisted'),
        ),
      ),
    )
    .orderBy(schema.registrationSequences.updatedAt, schema.registrationSequences.id)
    .$dynamic();
  if (now) query = query.limit(MAX_SEQUENCE_FAMILIES_PER_RUN);
  const rows = await query;

  return rows.map((row) => ({
    sequenceId: row.sequenceId,
    familyId: row.familyId,
    parentUserId: row.parentUserId,
    timeZone: row.timeZone,
    areaCoarse: row.areaCoarse,
    window: registrationSourceState(row.window),
    optIn: optInOf(row),
    outcome: row.outcome,
    waitlistPosition: row.waitlistPosition,
    waitlistStartedAt: row.waitlistStartedAt,
    courseUrl: row.courseUrl,
    courseOpensAt: row.courseOpensAt,
    readinessReady: row.readinessReady,
    lastReading: row.lastReading,
    pendingChange: registrationChange(row.pendingChange),
    pausedAt: row.pausedAt,
    dateReviewActionId: row.dateReviewActionId,
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
  const read = createRegistrationReader();
  return {
    compose: composeRegistrationReminder,
    live: {
      read,
      readForSend: createRegistrationReader(),
      claimDue: claimDueRegistrationChecks,
      refresh: refreshRegistrationWatch,
      claimSend: claimRegistrationSend,
      releaseSend: releaseRegistrationSend,
      reload: async (database, sequenceId) =>
        (await loadLiveSequences(database, sequenceId))[0] ?? null,
      draftReview: async (database, sequence) => {
        const change = sequence.pendingChange;
        if (
          change?.kind !== 'later' ||
          sequence.dateReviewActionId ||
          sequence.optIn !== 'opted_in'
        )
          return;
        const { actionId } = await draftInlineAction(
          {
            familyId: sequence.familyId,
            actor: sequence.parentUserId,
            intentKind: 'registration_date_review',
            childId: null,
            sourceAnswer: registrationChangeBody(change),
            title: 'Confirm changed registration date',
            sourceUrl: change.sourceUrl,
            origin: 'registration_sweep',
            contentProvenance: 'hale_authored',
          },
          database,
          pipelineClient(),
        );
        await database.transaction(async (tx) => {
          const [attached] = await tx
            .update(schema.registrationSequences)
            .set({ dateReviewActionId: actionId })
            .where(
              and(
                eq(schema.registrationSequences.id, sequence.sequenceId),
                isNull(schema.registrationSequences.dateReviewActionId),
                sql`${schema.registrationSequences.pendingChange}->>'key' = ${change.key}`,
              ),
            )
            .returning({ id: schema.registrationSequences.id });
          if (!attached)
            await tx
              .update(schema.actions)
              .set({
                revertedAt: new Date(),
                revertedReason: 'registration_date_changed',
                userVisibleState: 'reverted',
              })
              .where(eq(schema.actions.id, actionId));
          await tx.insert(schema.auditLog).values({
            familyId: sequence.familyId,
            actor: 'system',
            actionTaken: attached
              ? 'registration_date_review_proposed'
              : 'registration_date_review_obsolete',
            targetTable: 'actions',
            targetId: actionId,
            after: { sequenceId: sequence.sequenceId, changeKey: change.key },
          });
        });
      },
      acknowledgeChange: async (database, sequence) => {
        const change = sequence.pendingChange;
        if (!change) return;
        await database.transaction(async (tx) => {
          const [updated] = await tx
            .update(schema.registrationSequences)
            .set({ pendingChange: { ...change, notified: true } })
            .where(
              and(
                eq(schema.registrationSequences.id, sequence.sequenceId),
                sql`${schema.registrationSequences.pendingChange}->>'key' = ${change.key}`,
              ),
            )
            .returning({ id: schema.registrationSequences.id });
          if (!updated) return;
          await tx.insert(schema.auditLog).values({
            familyId: sequence.familyId,
            actor: 'system',
            actionTaken: 'registration_change_notified',
            targetTable: 'registration_sequences',
            targetId: sequence.sequenceId,
            after: { changeKey: change.key },
          });
        });
      },
    },
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
    loadLiveSequences: (database, now) => loadLiveSequences(database, undefined, undefined, now),
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
  };
}
