import { type Database, schema } from '@hale/db';
import { and, desc, eq, gte, isNull } from 'drizzle-orm';
import { normalizeKeyword } from '~/lib/channel/intake/keywords';
import { resolveFamilyOpen } from '~/lib/registration/match-registration-windows';
import { renderCheckInReply } from './copy.js';
import {
  CHECK_IN_LEAD_HOURS,
  CHECK_IN_REPLY_WINDOW_HOURS,
  type RegistrationOutcome,
  type SequenceState,
  awaitingOutcome,
  waitlistDeadline,
} from './schedule.js';
import { type Shortlist, buildShortlist } from './shortlist.js';

/**
 * VIL-242 · M7 — what a parent's answer to "how did it go?" is allowed to do.
 *
 * Three certainties, all deterministic, and the reason is sharper than the usual "no
 * model in the hot path": this reply starts a CLOCK. A misread "not waitlisted, we got
 * in" would schedule two guards for an offer that does not exist; a misread waitlist
 * filed as a win would drop the guards for one that does, and a family loses a spot
 * because Hale was confident. So matching is anchored and exact, never a substring
 * search — the same discipline as the CASL keywords and M8's health replies, which
 * exists because "not done yet" contains "done".
 *
 * ORDER OF OPERATIONS, deliberately the REVERSE of M8's. M8 matches the keyword first
 * so an ordinary message costs no query. Here the lookup comes first, because the parse
 * is meaningless without it: "in" means nothing in general and everything in the three
 * days after a registration morning. The lookup is one indexed read on a narrow table
 * and it is the common path's only cost.
 *
 * C2 SEAM (VIL-221). Everything this module declines — every `ignored` verdict — is the
 * conversational layer's to answer, and it never has to relitigate the three
 * certainties. The one place the two could collide is the single re-ask: the FIRST
 * unreadable message inside an open window is answered with the menu rather than
 * conversationally. That is bounded to exactly one message per window by
 * `reasked_at`, and when C2 lands it should take the re-ask branch over — the
 * certainties and the window bookkeeping stay here.
 */

export type CheckInIntent =
  | { outcome: 'registered' }
  | { outcome: 'waitlisted'; position: number | null }
  | { outcome: 'missed' };

/** The got-a-spot family. Exact on the normalized body. */
const REGISTERED_WORDS = new Set([
  'got in',
  'we got in',
  'got him in',
  'got her in',
  'got them in',
  'got a spot',
  'got spots',
  'we are in',
  "we're in",
  'were in',
  'registered',
  'all registered',
  'signed up',
  'made it',
  'success',
]);

/** The did-not-get-a-spot family. */
const MISSED_WORDS = new Set([
  'missed it',
  'we missed it',
  'missed',
  'no luck',
  "didn't get in",
  'didnt get in',
  "didn't make it",
  'didnt make it',
  'it was full',
  'full',
  'sold out',
  'too late',
]);

/**
 * A waitlist report. ANCHORED at the start of the message rather than searched for:
 * "not waitlisted, we got in" contains the word and means its opposite, and the
 * anchored form declines it (which lands on the re-ask, the safe outcome) instead of
 * starting a 36-hour clock for an offer nobody made.
 */
const WAITLIST_RE =
  /^(?:we(?:'re| are|re)?\s+)?(?:got\s+|are\s+|was\s+|were\s+|is\s+|on\s+the\s+)?waitlist(?:ed)?\b/;

/** The position inside a waitlist report: "#15", "number 15", or a bare 15. The digit
 * run is captured WHOLE (never a bounded slice) so a pasted phone number is rejected by
 * the plausibility check below rather than truncated into a plausible-looking rank. */
const POSITION_RE = /(?:#|\bnumber\s+|\bno\.?\s+|\bposition\s+|\bspot\s+)?(\d+)/;

/** A phone keyboard types a curly apostrophe; the word sets are written with a straight
 * one. Folded before matching so "we’re in" and "we're in" are the same answer. */
function normalizeReply(body: string): string {
  return normalizeKeyword(body.replace(/[‘’ʼ`]/g, "'"));
}

/**
 * What this reply IS, or null when Hale cannot read it. Waitlist is tried first: it is
 * the only one of the three that carries a value, and it is a pattern rather than a
 * fixed phrase.
 */
export function matchCheckInReply(body: string): CheckInIntent | null {
  const text = normalizeReply(body);
  if (text.length === 0) return null;

  if (WAITLIST_RE.test(text)) {
    const match = text.replace(WAITLIST_RE, '').match(POSITION_RE);
    const parsed = match ? Number(match[1]) : Number.NaN;
    // A four-digit ceiling: a phone number pasted into the message is not a position,
    // and a fabricated "#4165550100" in the reply would be nonsense a parent has to
    // correct. An unreadable position is null, never a guess.
    const position = Number.isInteger(parsed) && parsed > 0 && parsed <= 9999 ? parsed : null;
    return { outcome: 'waitlisted', position };
  }
  if (REGISTERED_WORDS.has(text)) return { outcome: 'registered' };
  if (MISSED_WORDS.has(text)) return { outcome: 'missed' };
  return null;
}

/** The one window this family is currently being asked about, assembled for the pure
 * handler: the live sequence, the state the schedule reasons over, and the shortlist
 * the reply copy is rendered from. */
export interface AwaitingSequence {
  sequenceId: string;
  familyId: string;
  parentUserId: string;
  state: SequenceState;
  shortlist: Shortlist;
  /** Non-null once the single gentle re-ask has been spent. */
  reaskedAt: Date | null;
}

export interface RecordOutcomeInput {
  sequenceId: string;
  familyId: string;
  parentUserId: string;
  windowRef: Shortlist['windowRef'];
  outcome: RegistrationOutcome;
  position: number | null;
  waitlistStartedAt: Date | null;
  waitlistDeadlineAt: Date | null;
  now: Date;
}

export interface SequenceReplyDeps {
  loadAwaitingSequence(
    database: Database,
    familyId: string,
    now: Date,
  ): Promise<AwaitingSequence | null>;
  recordOutcome(database: Database, input: RecordOutcomeInput): Promise<void>;
  recordReask(database: Database, sequenceId: string, now: Date): Promise<void>;
}

export type SequenceReplyOutcome =
  | { status: 'recorded'; outcome: RegistrationOutcome; reply: string }
  | { status: 'reasked'; reply: string }
  | { status: 'ignored'; reason: 'no_open_window' | 'reask_spent' };

export async function handleSequenceReply(
  database: Database,
  input: { familyId: string; body: string; now: Date },
  deps: SequenceReplyDeps,
): Promise<SequenceReplyOutcome> {
  const sequence = await deps.loadAwaitingSequence(database, input.familyId, input.now);
  // The loader's own filter is narrow; this is the authoritative check, and it is the
  // pure one — a sequence that already has an outcome, or whose window has passed out
  // of the reply horizon, is not owed an answer.
  if (!sequence || !awaitingOutcome(sequence.state, input.now)) {
    return { status: 'ignored', reason: 'no_open_window' };
  }

  const intent = matchCheckInReply(input.body);
  if (intent === null) {
    if (sequence.reaskedAt !== null) return { status: 'ignored', reason: 'reask_spent' };
    await deps.recordReask(database, sequence.sequenceId, input.now);
    return {
      status: 'reasked',
      reply: renderCheckInReply({
        shortlist: sequence.shortlist,
        timeZone: sequence.state.timeZone,
        now: input.now,
        reply: { outcome: null },
      }),
    };
  }

  const waitlisted = intent.outcome === 'waitlisted';
  const startedAt = waitlisted ? input.now : null;
  // The clock runs from the parent's message, on the MUNICIPALITY's published rule.
  // Hale never sees the offer email, so it cannot know when the offer landed — and it
  // cannot invent a response window where the town publishes none.
  const deadlineAt =
    startedAt === null
      ? null
      : waitlistDeadline(startedAt, sequence.shortlist.waitlistResponseHours);

  await deps.recordOutcome(database, {
    sequenceId: sequence.sequenceId,
    familyId: sequence.familyId,
    parentUserId: sequence.parentUserId,
    windowRef: sequence.shortlist.windowRef,
    outcome: intent.outcome,
    position: waitlisted ? intent.position : null,
    waitlistStartedAt: startedAt,
    waitlistDeadlineAt: deadlineAt,
    now: input.now,
  });

  return {
    status: 'recorded',
    outcome: intent.outcome,
    reply: renderCheckInReply({
      shortlist: sequence.shortlist,
      timeZone: sequence.state.timeZone,
      now: input.now,
      reply: waitlisted
        ? { outcome: 'waitlisted', position: intent.position, deadlineAt }
        : { outcome: intent.outcome },
    }),
  };
}

// ── prod wiring ──────────────────────────────────────────────────────────────

/** The `family_memory_facts.fact_key` namespace for a recorded registration outcome. */
export const REGISTRATION_FACT_KEY_PREFIX = 'registration_outcome:';

/**
 * Stamped on every fact this module writes, and REQUIRED on every fact read back from
 * that namespace — M8's precedent, and the same trust boundary.
 *
 * `family_memory_facts` is not a private table: Ask Hale's `save_memory` tool lets a
 * model choose both `fact_type` and `fact_key` freely, so anything that can get one
 * sentence into a coach turn can write into this namespace. The WRITER is what makes a
 * row trustworthy, never the key.
 */
export const REGISTRATION_FACT_WRITER = 'registration-sequence-reply';

/**
 * Persist what the parent reported: the sequence row (which drives the waitlist guards),
 * the immutable audit row (rule #6), and the family memory fact that lets the rest of
 * Hale know this household got into swim this fall.
 *
 * ONE transaction, audit FIRST — the discipline recordWatchConsent and M8 both use. A
 * state change that landed without its audit row would be exactly the gap rule #6 admits
 * no exception to. The audit payload is enum-shaped provenance only: the municipality,
 * the cycle and the outcome, never the rendered message.
 */
export async function recordRegistrationOutcome(
  database: Database,
  input: RecordOutcomeInput,
): Promise<void> {
  await database.transaction(async (tx) => {
    await tx.insert(schema.auditLog).values({
      familyId: input.familyId,
      actor: input.parentUserId,
      actionTaken: 'registration_outcome_recorded',
      targetTable: 'registration_sequences',
      targetId: input.sequenceId,
      after: {
        outcome: input.outcome,
        municipality: input.windowRef.municipality,
        cycleLabel: input.windowRef.cycleLabel,
        waitlistPosition: input.position,
      },
    });
    await tx
      .update(schema.registrationSequences)
      .set({
        outcome: input.outcome,
        outcomeAt: input.now,
        waitlistPosition: input.position,
        waitlistStartedAt: input.waitlistStartedAt,
        waitlistDeadlineAt: input.waitlistDeadlineAt,
        updatedAt: input.now,
      })
      .where(eq(schema.registrationSequences.id, input.sequenceId));
    // Typed 'logistic', not 'medical' or 'preference': this records an administrative
    // fact about a household's autumn, and it is family-scoped rather than child-scoped
    // because a municipal window is registered for as a household — the shortlist may
    // have covered two siblings and one row cannot honestly be attributed to one.
    await tx.insert(schema.familyMemoryFacts).values({
      familyId: input.familyId,
      childId: null,
      factType: 'logistic',
      factKey: `${REGISTRATION_FACT_KEY_PREFIX}${input.windowRef.id}`,
      factValue: {
        outcome: input.outcome,
        municipality: input.windowRef.municipality,
        programDomain: input.windowRef.programDomain,
        cycleLabel: input.windowRef.cycleLabel,
        waitlistPosition: input.position,
      },
      inferredBy: REGISTRATION_FACT_WRITER,
    });
  });
}

/**
 * The one open window this family could be answering about: the newest sequence whose
 * window has opened, that carries no outcome yet. The pure `awaitingOutcome` check in
 * the handler is what actually decides — this is the narrow read that feeds it.
 */
export async function loadAwaitingSequence(
  database: Database,
  familyId: string,
  now: Date,
): Promise<AwaitingSequence | null> {
  const horizonStart = new Date(
    now.getTime() - (CHECK_IN_LEAD_HOURS + CHECK_IN_REPLY_WINDOW_HOURS) * 3_600_000,
  );
  const [row] = await database
    .select({
      sequenceId: schema.registrationSequences.id,
      parentUserId: schema.registrationSequences.parentUserId,
      reaskedAt: schema.registrationSequences.reaskedAt,
      actionId: schema.registrationSequences.actionId,
      window: schema.registrationWindows,
      timezone: schema.users.timezone,
      areaCoarse: schema.families.areaCoarse,
    })
    .from(schema.registrationSequences)
    .innerJoin(
      schema.registrationWindows,
      eq(schema.registrationWindows.id, schema.registrationSequences.windowId),
    )
    .innerJoin(schema.users, eq(schema.users.id, schema.registrationSequences.parentUserId))
    .innerJoin(schema.families, eq(schema.families.id, schema.registrationSequences.familyId))
    .where(
      and(
        eq(schema.registrationSequences.familyId, familyId),
        isNull(schema.registrationSequences.outcome),
        gte(schema.registrationWindows.openAt, horizonStart),
      ),
    )
    .orderBy(desc(schema.registrationWindows.openAt))
    .limit(1);
  if (!row) return null;

  const children = await database
    .select({
      id: schema.children.id,
      name: schema.children.name,
      dateOfBirth: schema.children.dateOfBirth,
    })
    .from(schema.children)
    .where(eq(schema.children.familyId, familyId));

  const optIn = await readOptIn(database, row.actionId);
  // THIS family's open instant — the same one the ladder was anchored on. A resident
  // household registers a week before the general date, so reading the general one
  // would refuse the answer to a question Hale had already asked them.
  const open = resolveFamilyOpen(row.window, row.areaCoarse);
  const shortlist = buildShortlist(
    {
      window: row.window,
      matchedChildAgesMonths: [],
      ageApproximate: false,
      isResidentWindow: open.isResidentWindow,
      opensForFamilyAt: open.opensForFamilyAt,
      generalOpenAt: row.window.openAt,
    },
    children,
    now,
  );
  if (!shortlist) return null;

  return {
    sequenceId: row.sequenceId,
    familyId,
    parentUserId: row.parentUserId,
    reaskedAt: row.reaskedAt,
    shortlist,
    state: {
      openAt: open.opensForFamilyAt,
      timeZone: row.timezone,
      optIn,
      outcome: null,
      waitlistStartedAt: null,
      waitlistResponseHours: row.window.waitlistResponseHours,
    },
  };
}

/**
 * Whether the parent approved the shortlist, read LIVE off the approval spine rather
 * than mirrored onto the sequence — see registration-sequences.ts for why there is no
 * status column. A reverted draft is a decline, an executed one is the opt-in, and a
 * draft still sitting in the queue is neither yet.
 */
export async function readOptIn(
  database: Database,
  actionId: string | null,
): Promise<SequenceState['optIn']> {
  if (actionId === null) return 'missing';
  const [row] = await database
    .select({
      executedAt: schema.actions.executedAt,
      revertedAt: schema.actions.revertedAt,
    })
    .from(schema.actions)
    .where(eq(schema.actions.id, actionId))
    .limit(1);
  if (!row) return 'missing';
  if (row.revertedAt !== null) return 'declined';
  return row.executedAt !== null ? 'opted_in' : 'pending';
}

export function defaultSequenceReplyDeps(): SequenceReplyDeps {
  return {
    loadAwaitingSequence,
    recordOutcome: recordRegistrationOutcome,
    recordReask: async (database, sequenceId, now) => {
      await database
        .update(schema.registrationSequences)
        .set({ reaskedAt: now, updatedAt: now })
        .where(eq(schema.registrationSequences.id, sequenceId));
    },
  };
}
