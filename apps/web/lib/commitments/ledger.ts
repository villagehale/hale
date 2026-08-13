import { type AgentCommitment, type Database, schema } from '@hale/db';
import { and, asc, eq, isNull, lte } from 'drizzle-orm';

/**
 * MEM-10 · THE OPEN-LOOPS LEDGER — Hale's own promises, as data.
 *
 * THE INVARIANT: every surface that PROMISES writes here; every surface that asks what
 * Hale OWES reads here.
 *
 * It is written down because the alternative is what shipped. "Your first weekend find
 * lands in a day or two" is a commitment with a clock on it, and until this module the
 * only thing holding it was the hope that the 48h sweep would select that family — a
 * sentence in a transcript, in a product whose transcript is going to be compacted. An
 * agent's own commitments are precisely the content that cannot survive as prose, which
 * is the whole argument for rows: a promise nobody can query is a promise nobody can be
 * shown to have broken.
 *
 * THREE DISCIPLINES, and each one is a defect this module exists to make unexpressible:
 *
 *   1. SEND-TIME ONLY. A promise is minted against the outbound `channel_messages` row
 *      that CARRIED it (lib/health/told.ts's rule, for the same reason): composing is
 *      not promising, and a message that never reached a transport must not put a family
 *      in the overdue column. No ledger row, no debt — named, logged, never silent.
 *   2. ONE OPEN PROMISE OF A KIND PER FAMILY, enforced by a partial unique index rather
 *      than by care. It is what lets the fulfilling surface close "the first-find promise
 *      for this family" without a correlation id, and it is why a re-fired webhook cannot
 *      mint the same debt twice.
 *   3. OVERDUE IS A QUERY, not a state. Nothing marks a promise late; `due_at < now` on
 *      an open row IS late. A sweep cannot forget to flag what it never has to write.
 *
 * Nothing in here throws. Every writer runs AFTER a message has already gone to a parent,
 * where an exception buys a carrier retry and a duplicate send — so each failure comes
 * back as a named outcome with the cost stated in the log (rule #11).
 */

export type CommitmentKind = AgentCommitment['commitmentKind'];

/**
 * Why an open promise was voided rather than kept. A closed vocabulary, because this
 * string is the ledger's only account of a debt that stopped being owed without anyone
 * delivering on it.
 */
export type CommitmentCancelReason =
  | 'shortlist_declined'
  | 'channel_revoked'
  /**
   * A newer offer of the same kind replaced this one. The only reason in this list a
   * production path spends today, and it exists because the partial unique index makes
   * superseding the ONLY way to offer twice: without it a family who ignored one plan
   * offer could never be offered another, forever, and the second offer's insert would
   * conflict in silence.
   */
  | 'plan_offer_superseded';

/**
 * What became of a promise. `already_open` is deliberately NOT folded into either of the
 * other two (rule #11): it is neither a fresh debt nor a failure, and a caller that
 * cannot tell them apart cannot tell a duplicate tick from a lost write.
 */
export type CommitmentRecordOutcome =
  | { status: 'recorded'; commitmentId: string }
  | { status: 'already_open' }
  | { status: 'not_recorded'; reason: 'no_ledger_row' | 'write_failed' };

/** What became of a closure. `none_open` is the common outcome and not a failure — most
 * messages answer no promise at all. */
export type CommitmentCloseOutcome =
  | { status: 'closed'; commitmentIds: string[] }
  | { status: 'none_open' }
  | { status: 'not_closed'; reason: 'no_ledger_row' | 'write_failed' };

/** The predicate that IS "still owed": not kept, not voided. Written once so a reader
 * and the unique index cannot disagree about what open means. */
function openPredicate() {
  return and(
    isNull(schema.agentCommitments.fulfilledAt),
    isNull(schema.agentCommitments.cancelledAt),
  );
}

/**
 * Record that a message which HAS BEEN SENT made this family a promise.
 *
 * Called with the id of the ledger row that carried it, so a compose that never reached
 * a transport — and therefore has no row — cannot put anyone in Hale's debt.
 */
export async function recordCommitment(
  database: Database,
  input: {
    familyId: string;
    kind: CommitmentKind;
    /** The promise in one short, parent-safe sentence (rule #1). */
    summary: string;
    /** WHICH plan, for the kinds that have a subject — a `PlanTopic`, never free text.
     * Omitted by the kinds that do not (see the column's own note). */
    topic?: string | null;
    /** WHOSE plan, when one child was named. Null for a household question. */
    subjectChildId?: string | null;
    dueAt: Date;
    channelMessageId: string | null;
  },
): Promise<CommitmentRecordOutcome> {
  if (input.channelMessageId === null) {
    console.error(
      { familyId: input.familyId, kind: input.kind },
      'commitments: promise made with no ledger row - not recorded, this debt is invisible',
    );
    return { status: 'not_recorded', reason: 'no_ledger_row' };
  }
  try {
    const [row] = await database
      .insert(schema.agentCommitments)
      .values({
        familyId: input.familyId,
        commitmentKind: input.kind,
        summary: input.summary,
        topic: input.topic ?? null,
        subjectChildId: input.subjectChildId ?? null,
        dueAt: input.dueAt,
        createdFrom: input.channelMessageId,
      })
      // The partial unique index refuses a second open promise of this kind. A tick that
      // ran twice must cost one rejected insert, never a second debt.
      .onConflictDoNothing()
      .returning({ id: schema.agentCommitments.id });
    if (!row) return { status: 'already_open' };
    return { status: 'recorded', commitmentId: row.id };
  } catch (err) {
    console.error(
      { err, familyId: input.familyId, kind: input.kind },
      'commitments: promise write failed - this debt is invisible',
    );
    return { status: 'not_recorded', reason: 'write_failed' };
  }
}

/**
 * Mark this family's open promise of `kind` as KEPT, by the message that kept it.
 *
 * `fulfilledBy` is the point: a kept promise says what kept it, so the receipts surface
 * can show the parent the message rather than Hale's own word for it. The schema's
 * closure check forbids the half-row, and so does this — a fulfilment with nothing to
 * point at is refused rather than written.
 */
export async function fulfillCommitment(
  database: Database,
  input: {
    familyId: string;
    kind: CommitmentKind;
    /** The `channel_messages` id of the message that made good on the promise. */
    channelMessageId: string | null;
    now: Date;
  },
): Promise<CommitmentCloseOutcome> {
  if (input.channelMessageId === null) {
    console.error(
      { familyId: input.familyId, kind: input.kind },
      'commitments: fulfilment with no ledger row - promise left open, Hale will read as still owing it',
    );
    return { status: 'not_closed', reason: 'no_ledger_row' };
  }
  return close(
    database,
    { familyId: input.familyId, kind: input.kind },
    { fulfilledAt: input.now, fulfilledBy: input.channelMessageId },
  );
}

/**
 * Void this family's open promise of `kind` — it can no longer be kept, and that is not
 * a failure to report as one. The reason is required by the schema and by the argument:
 * a debt that disappears without an account of why is the one closure a ledger must not
 * be able to express.
 *
 * NO PRODUCTION CALLER YET, deliberately. The two candidate triggers — a household
 * losing its last sendable channel, and a parent revoking the approval a registration
 * plan rested on — are send-policy calls, the same boundary that keeps the overdue sweep
 * from texting anyone in v1. The writer exists so that closing a promise as VOIDED is a
 * supported move rather than a schema column nothing may legally write.
 */
export async function cancelCommitment(
  database: Database,
  input: {
    familyId: string;
    kind: CommitmentKind;
    reason: CommitmentCancelReason;
    now: Date;
  },
): Promise<CommitmentCloseOutcome> {
  return close(
    database,
    { familyId: input.familyId, kind: input.kind },
    { cancelledAt: input.now, cancelledReason: input.reason },
  );
}

/** The one closing write. Scoped by the open predicate, so a promise already kept or
 * already voided is never reopened or re-stamped by a later surface. */
async function close(
  database: Database,
  target: { familyId: string; kind: CommitmentKind },
  patch: Record<string, unknown>,
): Promise<CommitmentCloseOutcome> {
  try {
    const rows = await database
      .update(schema.agentCommitments)
      .set(patch)
      .where(
        and(
          eq(schema.agentCommitments.familyId, target.familyId),
          eq(schema.agentCommitments.commitmentKind, target.kind),
          openPredicate(),
        ),
      )
      .returning({ id: schema.agentCommitments.id });
    if (rows.length === 0) return { status: 'none_open' };
    return { status: 'closed', commitmentIds: rows.map((row) => row.id) };
  } catch (err) {
    console.error(
      { err, familyId: target.familyId, kind: target.kind },
      'commitments: close failed - promise left open, Hale will read as still owing it',
    );
    return { status: 'not_closed', reason: 'write_failed' };
  }
}

/** One promise Hale still owes this family. */
export interface OpenCommitment {
  id: string;
  kind: CommitmentKind;
  summary: string;
  dueAt: Date;
  /** Past its due time and still open — the state the family can feel. */
  overdue: boolean;
}

/**
 * THE open promise of one kind for one family, or null.
 *
 * Singular by construction, not by `.limit(1)`: the partial unique index permits at
 * most one, which is the property the whole offer→YES flow rests on. A `.limit(1)`
 * would read the same way today and would quietly pick a winner if the index were ever
 * dropped, so the query does not sort — if two rows ever come back, that is a broken
 * invariant and it is better seen than smoothed over.
 */
export async function loadOpenCommitment(
  database: Database,
  familyId: string,
  kind: CommitmentKind,
): Promise<{
  id: string;
  summary: string;
  topic: string | null;
  subjectChildId: string | null;
  dueAt: Date;
} | null> {
  const rows = await database
    .select({
      id: schema.agentCommitments.id,
      summary: schema.agentCommitments.summary,
      topic: schema.agentCommitments.topic,
      subjectChildId: schema.agentCommitments.subjectChildId,
      dueAt: schema.agentCommitments.dueAt,
    })
    .from(schema.agentCommitments)
    .where(
      and(
        eq(schema.agentCommitments.familyId, familyId),
        eq(schema.agentCommitments.commitmentKind, kind),
        openPredicate(),
      ),
    );
  return rows[0] ?? null;
}

/** One promise, anywhere, that has come due — the shape a sweep acts on. */
export interface DueCommitment {
  id: string;
  familyId: string;
  topic: string | null;
  /** The outbound row that carried the promise. The sweep reads the RECIPIENT back off
   * it: the parent who was texted is the one owed the follow-up, and a household read
   * would text a co-parent about a plan they never asked for. */
  createdFrom: string;
  dueAt: Date;
}

/**
 * Every family's open promise of `kind` whose time has come, oldest first.
 *
 * The cross-family read the check-in sweep runs each hour. It selects on the SAME
 * open predicate the index is partial on, so an hourly scan touches only the handful
 * of rows still outstanding rather than the whole history of Hale's promises.
 */
export async function loadDueCommitments(
  database: Database,
  kind: CommitmentKind,
  now: Date,
  limit: number,
): Promise<DueCommitment[]> {
  return database
    .select({
      id: schema.agentCommitments.id,
      familyId: schema.agentCommitments.familyId,
      topic: schema.agentCommitments.topic,
      createdFrom: schema.agentCommitments.createdFrom,
      dueAt: schema.agentCommitments.dueAt,
    })
    .from(schema.agentCommitments)
    .where(
      and(
        eq(schema.agentCommitments.commitmentKind, kind),
        lte(schema.agentCommitments.dueAt, now),
        openPredicate(),
      ),
    )
    .orderBy(asc(schema.agentCommitments.dueAt))
    .limit(limit);
}

/**
 * Everything Hale still owes this family, soonest first.
 *
 * Ordered by due time rather than by age because that is the order a chief of staff
 * would say them in, and it is the order they will be recited in at the END of the
 * coach's assembled context (the recitation position — a promise held in recent
 * attention rather than buried at the top of a window).
 */
export async function loadOpenCommitments(
  database: Database,
  familyId: string,
  now: Date,
): Promise<OpenCommitment[]> {
  const rows = await database
    .select({
      id: schema.agentCommitments.id,
      commitmentKind: schema.agentCommitments.commitmentKind,
      summary: schema.agentCommitments.summary,
      dueAt: schema.agentCommitments.dueAt,
    })
    .from(schema.agentCommitments)
    .where(and(eq(schema.agentCommitments.familyId, familyId), openPredicate()))
    .orderBy(asc(schema.agentCommitments.dueAt));
  return rows.map((row) => ({
    id: row.id,
    kind: row.commitmentKind,
    summary: row.summary,
    dueAt: row.dueAt,
    overdue: row.dueAt.getTime() < now.getTime(),
  }));
}

/**
 * What Hale owes, right now, across every family — the founder-digest read.
 *
 * `openCommitments` is carried alongside the overdue counts so the digest can tell an
 * empty ledger from a ledger with nothing late. "0 overdue" means two completely
 * different things in those two worlds, and only one of them is good news.
 */
export interface CommitmentDebt {
  /** Distinct families owed something past due — what a founder actually acts on. */
  overdueFamilies: number;
  overdueCommitments: number;
  openCommitments: number;
}

/**
 * A POINT-IN-TIME read, not a windowed one. Debt is a balance rather than a flow: a
 * promise made three weeks ago and still unkept is exactly the thing a weekly window
 * would hide.
 */
export async function aggregateCommitmentDebt(
  database: Database,
  now: Date,
): Promise<CommitmentDebt> {
  const rows = await database
    .select({
      familyId: schema.agentCommitments.familyId,
      dueAt: schema.agentCommitments.dueAt,
    })
    .from(schema.agentCommitments)
    .where(openPredicate());

  const overdueFamilies = new Set<string>();
  let overdueCommitments = 0;
  for (const row of rows) {
    if (row.dueAt.getTime() >= now.getTime()) continue;
    overdueCommitments += 1;
    overdueFamilies.add(row.familyId);
  }
  return {
    overdueFamilies: overdueFamilies.size,
    overdueCommitments,
    openCommitments: rows.length,
  };
}
