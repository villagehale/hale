import { type Database, type RegistrationWindow, schema } from '@hale/db';
import { ageInMonths } from '@hale/types';
import { and, eq, isNull, or } from 'drizzle-orm';
import { readWindows as readRegistrationWindows } from '~/lib/channel/intake/radar';
import type { ChannelTransport } from '~/lib/channel/intake/transport';
import { dedupeActive } from '~/lib/channel/ledger';
import { f14Allowlist, f14Enabled } from '~/lib/channel/nudge/run';
import { NUDGE_OPT_OUT } from '~/lib/channel/nudge/shell';
import {
  type OutboundGatePorts,
  type ProactiveHoldReason,
  assertProactiveSendAllowed,
  buildOutboundGatePorts,
  resolveSendTarget,
} from '~/lib/channel/outbound-gate';
import { draftInlineAction } from '~/lib/coach/inline-action';
import { localParts } from '~/lib/loop/prefs';
import { pipelineClient } from '~/lib/pipeline/client';
import {
  matchRegistrationWindows,
  resolveFamilyOpen,
} from '~/lib/registration/match-registration-windows';
import { loadClaimedWindowIds } from './claims.js';
import { renderSequenceLeg, renderShortlistRationale } from './copy.js';
import {
  HEADS_UP_MINUTE_LOCAL,
  type RegistrationOutcome,
  type SequenceLeg,
  type SequenceOptIn,
  dueLeg,
  legIsUrgent,
  waitlistDeadline,
} from './schedule.js';
import { type SequenceChild, type Shortlist, buildShortlist } from './shortlist.js';

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
}

export interface SequenceLedgerWrite {
  familyId: string;
  parentUserId: string;
  channel: 'sms';
  category: 'registration_sequence';
  templateKey: string;
  dedupeKey: string;
  status: 'sent';
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
    input: { familyId: string; actorUserId: string; childId: null; intentKind: string; rationale: string },
  ): Promise<string>;
  attachAction(database: Database, sequenceId: string, actionId: string): Promise<void>;
  /** Undo a claim whose shortlist could not be drafted. */
  releaseClaim(database: Database, sequenceId: string): Promise<void>;
  loadLiveSequences(database: Database, now: Date): Promise<LiveSequence[]>;
  buildGate(database: Database): OutboundGatePorts;
  dedupeActive(database: Database, dedupeKey: string): Promise<boolean>;
  resolveSendTarget(database: Database, parentUserId: string): Promise<string | null>;
  recordSend(database: Database, write: SequenceLedgerWrite): Promise<string>;
  audit(database: Database, row: SequenceAuditRow): Promise<void>;
  /** The real CPaaS transport lands with VIL-214. Until then the sweep decides and
   * composes without sending — and without writing a ledger row, so a leg that never
   * went out is not permanently marked as delivered. */
  transport: ChannelTransport | null;
}

export interface SequenceRunResult {
  /** False when neither the flag nor the allowlist armed the sweep (D21). */
  enabled: boolean;
  /** Shortlists claimed AND drafted this run. */
  proposed: number;
  /** Live sequences examined in the leg phase. */
  evaluated: number;
  sent: number;
  /** Decided + composed, but there is no transport yet (VIL-214). */
  composed: number;
  /** Live sequences with no leg due — the common outcome on most ticks. */
  quiet: number;
  deduped: number;
  failed: number;
  held: Record<ProactiveHoldReason, number>;
}

function emptyResult(enabled: boolean): SequenceRunResult {
  return {
    enabled,
    proposed: 0,
    evaluated: 0,
    sent: 0,
    composed: 0,
    quiet: 0,
    deduped: 0,
    failed: 0,
    held: { not_enrolled: 0, no_watch_consent: 0, frequency_cap: 0, quiet_hours: 0 },
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
    if (claimed.has(match.window.id)) return false;
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
        rationale: renderShortlistRationale(shortlist, family.timeZone, now),
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

type LegOutcome =
  | { kind: 'held'; reason: ProactiveHoldReason }
  | { kind: 'quiet' }
  | { kind: 'deduped' }
  | { kind: 'composed' }
  | { kind: 'sent' };

async function runLegForSequence(
  database: Database,
  sequence: LiveSequence,
  deps: SequenceRunDeps,
  now: Date,
): Promise<LegOutcome> {
  // THIS family's open instant, not the general one. A resident household in a town
  // that publishes a head start registers a week early, and a ladder anchored on the
  // general date would tap them on the shoulder days after their doors had opened.
  const { isResidentWindow, opensForFamilyAt } = resolveFamilyOpen(
    sequence.window,
    sequence.areaCoarse,
  );
  const leg = dueLeg(
    {
      openAt: opensForFamilyAt,
      timeZone: sequence.timeZone,
      optIn: sequence.optIn,
      outcome: sequence.outcome,
      waitlistStartedAt: sequence.waitlistStartedAt,
      waitlistResponseHours: sequence.window.waitlistResponseHours,
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
  const shortlist = shortlistForSequence(
    sequence,
    { isResidentWindow, opensForFamilyAt },
    children,
    now,
  );
  // A family whose children no longer fit the band (a birthday crossed the ceiling
  // between the proposal and the leg) has nothing honest left to be told about it.
  if (!shortlist) return { kind: 'quiet' };

  const body = renderSequenceLeg(leg, {
    shortlist,
    timeZone: sequence.timeZone,
    now,
    optIn: sequence.optIn,
    waitlist: {
      position: sequence.waitlistPosition,
      deadlineAt:
        sequence.waitlistStartedAt === null
          ? null
          : waitlistDeadline(sequence.waitlistStartedAt, sequence.window.waitlistResponseHours),
    },
  });
  if (!deps.transport) return { kind: 'composed' };

  const to = await deps.resolveSendTarget(database, sequence.parentUserId);
  if (!to) {
    // The gate just said this parent has a live channel, so there IS one — a missing
    // number here is a contradiction, not a state to paper over.
    throw new Error(`runRegistrationSequenceCron: no send target for ${sequence.parentUserId}`);
  }

  const { providerMessageId } = await deps.transport.send({
    to,
    body: `${body}\n\n${NUDGE_OPT_OUT}`,
  });
  const messageId = await deps.recordSend(database, {
    familyId: sequence.familyId,
    parentUserId: sequence.parentUserId,
    channel: 'sms',
    category: 'registration_sequence',
    templateKey: `registration_sequence:${leg}`,
    dedupeKey,
    status: 'sent',
    providerMessageId,
    sentAt: now,
  });
  await deps.audit(database, {
    familyId: sequence.familyId,
    actor: 'system',
    actionTaken: 'registration_sequence_leg_sent',
    targetTable: 'channel_messages',
    targetId: messageId,
    // Enum-shaped provenance only, never the rendered body (rule #1).
    after: {
      leg,
      windowId: sequence.window.id,
      municipality: sequence.window.municipality,
      cycleLabel: sequence.window.cycleLabel,
      urgent: legIsUrgent(leg),
    },
  });
  return { kind: 'sent' };
}

/** The shortlist a leg is rendered from, rebuilt against the LIVE window and today's
 * ages rather than stored: a child ages, a municipality corrects a band or a date, and
 * a leg must say what is true this morning. */
function shortlistForSequence(
  sequence: LiveSequence,
  open: { isResidentWindow: boolean; opensForFamilyAt: Date },
  children: readonly SequenceChild[],
  now: Date,
): Shortlist | null {
  return buildShortlist(
    {
      window: sequence.window,
      matchedChildAgesMonths: [],
      // The per-child hedge is rebuilt from the live band by buildShortlist itself, so
      // there is nothing for the match-level flag to carry here.
      ageApproximate: false,
      isResidentWindow: open.isResidentWindow,
      opensForFamilyAt: open.opensForFamilyAt,
      generalOpenAt: sequence.window.openAt,
    },
    children,
    now,
  );
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

  for (const sequence of sequences) {
    result.evaluated += 1;
    try {
      const outcome = await runLegForSequence(database, sequence, deps, now);
      if (outcome.kind === 'held') result.held[outcome.reason] += 1;
      else result[outcome.kind] += 1;
    } catch (err) {
      // One family's bad data must not silence every family after it.
      result.failed += 1;
      console.error({ err, sequenceId: sequence.sequenceId }, 'registration sequence: leg failed');
    }
  }
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
    dedupeActive: (database, dedupeKey) => dedupeActive(dedupeKey, database),
    resolveSendTarget,
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
    // VIL-214 brings the real CPaaS transport; until then nothing leaves the building.
    transport: null,
  };
}
