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
  | 'answered';

/**
 * WHY A TURN THAT ANSWERED WAS STILL A FAILURE.
 *
 * These are the four ways `disposeOfFailedTurn` can put words in front of a parent
 * without the coach having worked. They are DATA — they land in an audit row a PIPEDA
 * export renders — so they are snake_case enums that outlive the identifiers around
 * them.
 */
export type TurnFailureReason =
  /** The turn texted the parent and then broke on its own bookkeeping. They have their
   * answer; the failure is real and invisible to them. */
  | 'broke_after_answering'
  /** It broke after drafting, so the receipt names a count of real rows (copy.ts). */
  | 'drafts_receipt'
  /** They plainly answered something, the coach could not run, and Hale asked which. */
  | 'unplaced_choice'
  /** The composed apology went out. The 2026-08-22 shape. */
  | 'apology_sent'
  /** The provider was gone AND the text named an emergency, so the fixed safety line
   * went out with no model in the loop (smoke-alarm.ts). */
  | 'smoke_alarm';

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
  }): Promise<AnswerClaimOutcome>;
  /** Called before the turn is thrown back to the queue, so the re-drive knows the two
   * consuming steps are already paid for. */
  recordDeferred(input: {
    familyId: string;
    parentUserId: string;
    channelMessageId: string;
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
