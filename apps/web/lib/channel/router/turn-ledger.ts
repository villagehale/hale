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

export interface InboundTurnLedger {
  stageOf(input: { familyId: string; channelMessageId: string }): Promise<TurnStage>;
  /**
   * Called the instant the transport accepts the turn's ANSWER — before the ledger row,
   * before the audit row, before the thread. Send, then claim (the router's own ordering
   * rule): a claim written first would turn a send that failed into a text the parent
   * never gets, because the re-drive would read the claim and stay quiet. Written as
   * early after the send as possible for the mirror-image reason — every write between
   * the transport accepting and the claim landing is a window where a crash re-answers.
   */
  recordAnswered(input: {
    familyId: string;
    parentUserId: string;
    channelMessageId: string;
  }): Promise<void>;
  /** Called before the turn is thrown back to the queue, so the re-drive knows the two
   * consuming steps are already paid for. */
  recordDeferred(input: {
    familyId: string;
    parentUserId: string;
    channelMessageId: string;
  }): Promise<void>;
}
