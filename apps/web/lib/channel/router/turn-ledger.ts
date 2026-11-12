import type { IncidentFailure } from '~/lib/monitoring/provider-health';

/**
 * HOW FAR THIS TEXT ALREADY GOT — the router's memory of its own attempts at one inbound
 * message.
 *
 * The drain is at-least-once BY DESIGN (lib/cron/drain.ts), and the defer arc makes that
 * matter far more than it used to: an unreachable-model turn now throws back into
 * pg-boss and is re-driven with backoff, so a single text can enter this router nine
 * times over a two-hour outage instead of once. Three things in the pipeline are NOT
 * idempotent, and without this reader each of them would be multiplied by the retry
 * count:
 *
 *   THE REPLY. Twice-sent is the visible one, and it is the reason this exists at all.
 *   A turn that answered and then crashed on a bookkeeping write would answer AGAIN on
 *   the re-drive — the parent gets two of Hale's texts for one of theirs.
 *
 *   THE PARENT'S TURN IN THE THREAD. `appendMessage` writes a row every time, and the
 *   coach re-reads that thread on the next attempt. Nine copies of "what's for dinner"
 *   is a transcript that misrepresents the conversation to the model reading it.
 *
 *   THE HOURLY AGENT BUDGET. `limiter.check` COUNTS as it decides (rate-limit/postgres),
 *   so a deferred turn would spend a token per attempt. A parent who sent three texts
 *   into an outage would come back over their own limit and be answered with the flood
 *   line — the one reply the whole arc exists to avoid.
 *
 * So a re-driven turn re-runs everything that is a READ or a decision (the handlers, the
 * off-domain screen, the coach — the screen deliberately, so safety classification
 * self-heals when the model returns) and skips the two steps that CONSUME. What it can
 * never do is answer twice.
 *
 * It lives in `audit_log`, no new table and no migration, for the reason the smoke
 * alarm's claim does: rule #6 already requires an immutable row for what Hale did, so
 * the row that RECORDS the decision is the row that stops it being taken twice. See
 * `auditTurnLedger` in wiring.ts for the two action names, which are DATA.
 */

export type TurnStage =
  /** Never seen. The parent's message is not in the thread yet and nothing is spent. */
  | 'fresh'
  /** Attempted and handed back to the queue: threaded, counted, unanswered. */
  | 'deferred'
  /** Answered. Whatever else happens, this text does not get a second reply. */
  | 'answered'
  /** Read as part of an earlier text's turn (burst.ts). That turn threads it, counts it
   * and answers it; this text's own job has nothing left to do. Wins over `answered`: a
   * folded text's answered row is the anchor's answer, not one its own job gave. */
  | 'folded';

/**
 * The audit actions the turn ledger reads back. DATA values, like SMOKE_ALARM_ACTION in
 * wiring.ts: they are what a PIPEDA access request renders and what the re-drive gate
 * reads, so they are never renamed with the code.
 */
export const TURN_ANSWERED_ACTION = 'sms_turn_answered';
export const TURN_DEFERRED_ACTION = 'sms_turn_deferred';

/**
 * The third one, and the one whose absence made the 2026-08-22 turn unreadable. A DATA
 * value like the two above. The re-drive gate does NOT read it: a failed turn that
 * apologised is still answered, and answering twice is the thing the ledger exists to
 * prevent.
 */
export const TURN_FAILED_ACTION = 'sms_turn_failed';

/** A text read into an earlier text's turn. `after: { into, read }` names that turn. */
export const TURN_FOLDED_ACTION = 'sms_turn_folded';

/** The table every ledger row points at, named ONCE. The reader's predicate and the
 * writers' values are the same strings; a second copy is how a gate stops matching the
 * rows it is supposed to find. */
export const TURN_LEDGER_TARGET = 'channel_messages';

/**
 * How far back a ledger read looks.
 *
 * The ONLY index on audit_log is (family_id, occurred_at), and this read now runs on
 * every inbound text rather than only on a failed turn during an outage. Bounding the
 * time makes it a range scan over one family's recent rows instead of a filter over
 * their whole history.
 *
 * A week is far past the point where the answer could change: pg-boss exhausts this
 * queue's retries in one to two hours (channel/config.ts), so a turn older than that is
 * not going to be re-driven at all.
 */
export const TURN_LEDGER_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * WHY A TURN THAT ANSWERED WAS STILL A FAILURE.
 *
 * These are the ways `disposeOfFailedTurn` can put words in front of a parent
 * without the coach having worked, plus a notice that was composed and then
 * withheld. They are DATA — they land in an audit row a PIPEDA export renders —
 * so they are snake_case enums that outlive the identifiers around them.
 */
export type TurnFailureReason =
  /** The turn texted the parent and then broke on its own bookkeeping. They have their
   * answer; the failure is real and invisible to them. */
  | 'broke_after_answering'
  /** An answer sent as several bubbles stopped partway: a send, a receipt write or a
   * ledger read failed after the first bubble went. The parent has the bubbles before it,
   * the turn is claimed, and the rest is never sent. Not `broke_after_answering`: the
   * parent does not have the whole answer. */
  | 'reply_set_incomplete'
  /** It broke after drafting. The receipt is the model's, from the count alone. */
  | 'drafts_receipt'
  /** They plainly answered something, the coach could not run, and Hale asked which. */
  | 'unplaced_choice'
  /** The composed apology went out. The 2026-08-22 shape. */
  | 'apology_sent'
  /** The provider was gone AND the text named an emergency, so the fixed safety line
   * went out with no model in the loop (smoke-alarm.ts). */
  | 'smoke_alarm'
  /** A Gmail draft notice could not be composed. Nothing was texted. #ops is paged. */
  | 'notice_unsent'
  /** VIL-581 · the claim reader could not read the composed reply, and neither a drafts
   * receipt nor an apology could be written. Nothing was texted; the turn is claimed. */
  | 'claim_read_failed'
  /** A text about a sign-up ask could not be marked before its send, so nothing was sent
   * (signup/store.ts askStamp). The turn is claimed: the coach's writes landed. */
  | 'ask_order_unmarked';

/**
 * What became of an ANSWERED claim. 'already_answered' means another attempt's claim
 * was in the database first — under at-least-once delivery that is a concurrent or
 * crashed-and-redelivered consumer of the same turn, and the send THIS attempt just
 * made was a duplicate reply. It is a named outcome (rule #11), never a silent one:
 * the caller logs it, and the audit trail holds exactly one answered row either way.
 */
export type AnswerClaimOutcome = 'claimed' | 'already_answered';

export interface InboundTurnLedger {
  stageOf(input: { familyId: string; channelMessageId: string }): Promise<TurnStage>;
  /**
   * Called the instant the transport accepts the turn's ANSWER — before the ledger row,
   * before the audit row, before the thread. Send, then claim (the router's own ordering
   * rule): a claim written first would turn a send that failed into a text the parent
   * never gets, because the re-drive would read the claim and stay quiet. Written as
   * early after the send as possible for the mirror-image reason — every write between
   * the transport accepting and the claim landing is a window where a crash re-answers.
   *
   * The write is itself a CLAIM (audit P1-4): a unique index (migration 0106) lets
   * exactly one attempt record the answer, so a concurrent consumer — two drain runs
   * holding the same expiry-redelivered job — cannot both write clean history. It
   * cannot un-send the loser's duplicate text (send-then-claim makes that structural);
   * what it does is make the duplicate a fact with a name instead of a second
   * 'answered' row that reads as one turn behaving.
   */
  recordAnswered(input: {
    familyId: string;
    parentUserId: string;
    channelMessageId: string;
    /**
     * The texts this turn read with the anchor (burst.ts). Each gets its own answered row
     * in the same transaction as the anchor's claim, so every reader of the answered verb
     * (the re-drive gate, the unanswered sweep, ops-daily latency) sees them answered
     * with no fold-aware logic of its own. Empty on a lone text.
     */
    folded: readonly string[];
  }): Promise<AnswerClaimOutcome>;
  /**
   * The turn is over for this text, whatever its outcome: it holds its claim, so no later
   * turn reads it into a burst (burst.ts reads the claim). Written at the router's one
   * exit, because a handler that answers for itself and a step that ends with nothing
   * sent claim nothing on their own. A text already claimed keeps its claim.
   */
  recordRouted(input: { channelMessageId: string }): Promise<void>;
  /** Called before the turn is thrown back to the queue, so the re-drive knows the two
   * consuming steps are already paid for. */
  recordDeferred(input: {
    familyId: string;
    parentUserId: string;
    channelMessageId: string;
    /** Why the turn went back. Absent on the older model-unreachable path's
     * callers that only need the stage. */
    reason?: string;
    /**
     * The incident class, when the provider call that deferred this turn was
     * one (INCIDENT_FAILURES). A closed set. The ops page counts these rows; the
     * value is never a provider message.
     */
    providerFailure?: IncidentFailure;
  }): Promise<void>;
  /**
   * A known parent's inbound ended a step with nothing sent, or a step gave
   * up and the turn kept going. `reason` is one of the named outcomes in
   * channel/config.ts. Queryable: the row is the count, not a log line.
   */
  recordUnanswered(input: {
    familyId: string;
    parentUserId: string;
    channelMessageId: string;
    reason: string;
  }): Promise<void>;
  /**
   * THE TURN BROKE, AND SOMETHING WENT OUT ANYWAY.
   *
   * A THIRD row, not a replacement for `recordAnswered`, because the two answer
   * different questions and conflating them is the defect. "Did this text already get a
   * reply?" is the re-drive gate and must still say yes — the parent has the apology and
   * must not get a second one. "Did this turn work?" is what ops and a PIPEDA export
   * read, and on 2026-08-22 the whole trace of a failed turn was
   * `sms_reply_received → sms_turn_answered → sms_reply_sent`: three rows that all read
   * as success, for a turn whose only output was "I couldn't get that done for you".
   * No failure action of any kind existed anywhere in the family's history.
   *
   * Never on the DEFERRED path — that one has `sms_turn_deferred` already, and a turn
   * that said nothing is a different outcome from one that apologised.
   */
  recordFailed(input: {
    familyId: string;
    parentUserId: string;
    channelMessageId: string;
    reason: TurnFailureReason;
  }): Promise<void>;
}
