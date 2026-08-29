import type { Database } from '@hale/db';
import {
  type CommitmentCloseOutcome,
  type CommitmentRecordOutcome,
  cancelCommitment,
  fulfillCommitment,
  loadOpenCommitment,
  recordCommitment,
} from '~/lib/commitments/ledger';
import { type HealthCheckpoint, checkpointById, parseCheckpointRef } from './checkpoints';

/**
 * THE HEALTH CHECKPOINT'S OFFER, as a row — the missing half of M8.
 *
 * THE INVARIANT this module exists to restore: an outbound message that INVITES an
 * acceptance registers the standing question at SEND TIME, in the same flow as the send,
 * on the ledger the reply resolver reads. One reader, one row, no prose-only offers.
 *
 * The nudge ends "Done, or want me to add booking it to your week?" (health/copy.ts).
 * That is an offer — the parent says yes and a `book_checkup` action is drafted for their
 * approval. Every other offer Hale makes writes itself down: a plan offer mints a
 * `plan_offer` commitment, an introduction mints a proposal row, a drafted change IS an
 * `actions` row. This one wrote nothing, so `open-questions.ts` could not list it, so the
 * resolver was never told the question existed.
 *
 * WHAT THAT COST, IN PRODUCTION, 2026-08-20. A parent was offered the 18-month visit at
 * 10:00 and accepted it at 14:20. The resolver was holding two unrelated standing
 * questions (a flagged calendar draft and an introduction) and none of them was the offer
 * the parent was answering — so Hale asked them to choose between two things they had not
 * been offered, and then refused the one they picked. The acceptance was never heard.
 * The patch that "teaches the resolver about health" would have been a third reader of a
 * question nobody had written down; this is the row instead.
 *
 * WHY THE COMMITMENTS LEDGER AND NOT A NEW TABLE. MEM-10 already models exactly this: a
 * promise, with a clock, that at most one of a kind may be open per family. The partial
 * unique index is what makes a bare "yes" resolvable without a correlation id, and the
 * digest that counts what Hale owes gets this offer for free.
 */

/**
 * How long an accepted-or-not offer stands.
 *
 * ONE WEEK, and it is not a new number: it is the nudge's own relevance window. The
 * proactive gate lets a family hear from this sweep at most once every seven days, and
 * the non-booking close says "want a reminder next week?" out loud — so a week is the
 * span over which "the thing Hale just texted me about" is unambiguous. Past it the
 * parent is answering something else, and the row stops being a question rather than
 * being deleted (the ledger keeps what Hale offered even after it lapses).
 */
export const CHECKUP_OFFER_TTL_HOURS = 7 * 24;

/**
 * The offer in one parent-safe sentence — the ledger's `summary`, and the line the
 * resolver is shown as the question.
 *
 * Built from the checkpoint's own `task`, which is a constant in the reviewed table and
 * is already verbatim in the SMS the parent is holding. Rule #1's strictest reading is
 * satisfied by construction: a checkpoint task is a statement about a PROVINCIAL
 * SCHEDULE, never about a child (see checkpoints.ts, rule 1), so there is nothing here
 * a model could be told that Hale did not already text.
 */
export function checkupOfferSummary(checkpoint: HealthCheckpoint): string {
  return `An offer to add booking this to your week: ${checkpoint.task}`;
}

/**
 * What became of the offer's row. `not_an_offer` is a first-class outcome and not a
 * silent skip (rule #11): most health checkpoints are paperwork and close with "want a
 * reminder next week?", which invites nothing — so the sender calls this for every health
 * nudge and the ANSWER to "was an offer actually made?" lives in one place, next to the
 * `booking` flag the copy branches on.
 */
export type CheckupOfferRecordOutcome =
  | { status: 'recorded'; commitmentId: string }
  | { status: 'not_an_offer' }
  | { status: 'not_recorded'; reason: 'no_ledger_row' | 'unknown_checkpoint' | 'write_failed' | 'already_open' };

export interface CheckupOfferPorts {
  cancelCommitment: typeof cancelCommitment;
  recordCommitment: typeof recordCommitment;
}

export function defaultCheckupOfferPorts(): CheckupOfferPorts {
  return { cancelCommitment, recordCommitment };
}

/**
 * Write the offer down, against the message that carried it.
 *
 * SUPERSEDE FIRST, for the reason `recordPlanOffer` states: the partial unique index
 * permits one open offer of a kind per family, so without this a household that ignored
 * one checkpoint offer could never be offered another — silently, forever. Cancelling is
 * also the honest reading, because the message that just went out is the offer now.
 */
export async function recordCheckupOffer(
  database: Database,
  input: {
    familyId: string;
    /** The matcher's own checkpoint identity, exactly as the told-marker carries it. */
    ref: string;
    /** The outbound row that carried the offer. Null means it never reached a transport,
     * and an unsent offer is not an offer. */
    channelMessageId: string | null;
    now: Date;
  },
  ports: CheckupOfferPorts,
): Promise<CheckupOfferRecordOutcome> {
  const parsed = parseCheckpointRef(input.ref);
  const checkpoint = parsed ? checkpointById(parsed.checkpointId) : null;
  if (!parsed || !checkpoint) {
    console.error(
      { familyId: input.familyId },
      'checkup offer: unreadable checkpoint ref - not recorded, a later YES will find nothing',
    );
    return { status: 'not_recorded', reason: 'unknown_checkpoint' };
  }
  // The same flag the copy branched on when it chose the close. A paperwork checkpoint
  // asked for nothing, so there is nothing standing to answer.
  if (!checkpoint.booking) return { status: 'not_an_offer' };

  if (input.channelMessageId === null) {
    console.error(
      { familyId: input.familyId, checkpointId: checkpoint.id },
      'checkup offer: no ledger row for the message that carried it - not recorded, a later YES will find nothing',
    );
    return { status: 'not_recorded', reason: 'no_ledger_row' };
  }

  await ports.cancelCommitment(database, {
    familyId: input.familyId,
    kind: 'checkup_offer',
    reason: 'checkup_offer_superseded',
    now: input.now,
  });

  const outcome: CommitmentRecordOutcome = await ports.recordCommitment(database, {
    familyId: input.familyId,
    kind: 'checkup_offer',
    summary: checkupOfferSummary(checkpoint),
    // A reviewed-table id, never free text — see the column's own note.
    topic: checkpoint.id,
    subjectChildId: parsed.childId,
    dueAt: new Date(input.now.getTime() + CHECKUP_OFFER_TTL_HOURS * 3_600_000),
    channelMessageId: input.channelMessageId,
  });
  if (outcome.status === 'recorded') {
    return { status: 'recorded', commitmentId: outcome.commitmentId };
  }
  // `already_open` after a successful supersede means the cancel did not match — a lost
  // write, not a duplicate tick. Named as a failure here rather than folded in with the
  // ledger's benign reading, because at THIS call site it means the parent was just
  // offered a visit whose YES will resolve to the wrong checkpoint.
  console.error(
    { familyId: input.familyId, checkpointId: checkpoint.id, reason: outcome.status },
    'checkup offer: the offer was sent but not recorded - a YES will not resolve to it',
  );
  return {
    status: 'not_recorded',
    reason: outcome.status === 'already_open' ? 'already_open' : outcome.reason,
  };
}

/** A standing offer this family may still accept, resolved back to what accepting it
 * would draft. */
export interface OpenCheckupOffer {
  /** The commitment row's id — the open question's stable id. */
  id: string;
  checkpoint: HealthCheckpoint;
  /** Whose visit, or null for a household-scoped checkpoint. */
  childId: string | null;
  summary: string;
  /** When the offer sentence went out — the ledger row's mint time (recorded against
   * the sent message). The open-question reader's recency fact. */
  askedAt: Date;
}

/**
 * THE offer this family may answer right now, or null.
 *
 * THE TTL IS APPLIED HERE, at the one reader, so an expired offer can never be listed as
 * an open question — the resolver is never shown a choice a parent cannot take, and the
 * disambiguation sentence can never name a lapsed one. Plan offers keep the same shape
 * for the same reason (wiring.ts): an expired offer is still an open ledger row, it has
 * simply stopped being answerable.
 *
 * A topic this build no longer knows resolves to null rather than to a guess. Logged,
 * because the turn then goes to the coach, which will read the parent's message properly.
 */
export async function loadOpenCheckupOffer(
  database: Database,
  familyId: string,
  now: Date,
): Promise<OpenCheckupOffer | null> {
  const offer = await loadOpenCommitment(database, familyId, 'checkup_offer');
  if (!offer || offer.dueAt.getTime() < now.getTime()) return null;

  const checkpoint = offer.topic === null ? null : checkpointById(offer.topic);
  if (!checkpoint) {
    console.error(
      { familyId, topic: offer.topic },
      'checkup offer: open offer names an unknown checkpoint - treating it as closed',
    );
    return null;
  }
  return {
    id: offer.id,
    checkpoint,
    childId: offer.subjectChildId,
    summary: offer.summary,
    askedAt: offer.createdAt,
  };
}

/**
 * The offer was ACCEPTED and the draft exists — close it, against the message that told
 * the parent so.
 *
 * FULFILLED, NOT CANCELLED. The offer promised a draft on their week and a draft is what
 * happened, so marking it voided would put a false entry in the one ledger that says what
 * Hale actually did. It is closed AFTER the receipt reaches the parent, for the reason
 * every MEM-10 writer closes late: a turn that drafted and then failed to reply left the
 * parent with no idea the offer was taken, and re-driving it must find the offer still
 * standing.
 */
export async function fulfillCheckupOffer(
  database: Database,
  input: { familyId: string; channelMessageId: string | null; now: Date },
): Promise<CommitmentCloseOutcome> {
  return fulfillCommitment(database, {
    familyId: input.familyId,
    kind: 'checkup_offer',
    channelMessageId: input.channelMessageId,
    now: input.now,
  });
}
