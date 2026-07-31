import type { Database } from '@hale/db';
import {
  type SequenceReplyDeps,
  handleSequenceReply,
} from '~/lib/registration/sequence/reply';
import { type HealthReplyDeps, handleHealthCheckpointReply } from '~/lib/health/reply';
import { type ApprovalSpine, resolveApproval } from './approval';
import { checkupDraftedReply, healthDoneReply } from './copy';
import { matchFastPath } from './fast-path';
import type { DeterministicHandler, HandlerContext, HandlerVerdict } from './route';

/**
 * VIL-220 · C1 — the deterministic handlers, and the order they run in.
 *
 * Each one adapts a module that already owns its own certainty. None of them re-decides
 * anything: the approval preconditions live in the actions spine, the health matching
 * lives in M8. What lives HERE is only the mapping from those verdicts to a text
 * message, and the order.
 *
 * THE ORDER. "yes" is the one word both handlers could claim, and the rule that settles
 * it is not "approvals are more important" — it is that a handler may only claim a word
 * when it has something concrete for the word to mean:
 *
 *   · The approval handler claims a bare affirmative ONLY when an action is actually
 *     drafted and waiting. With none — the overwhelmingly common case — it declines,
 *     and the health nudge's own offer gets its answer. That is what stops the first
 *     handler in the chain from starving the ones behind it, and it is asserted in
 *     handlers.test.ts in both directions.
 *
 *   · When BOTH are open, approvals win. A draft is a question Hale asked and is holding
 *     an answer for, and it is the only one of the two whose wrong answer executes
 *     something the parent cannot see — a mis-filed "done" is recoverable, a mis-fired
 *     calendar write needs an undo.
 *
 * An ORDINAL ("YES 2") never reaches the health handler at all: M8 matches exact words,
 * so it declines anything carrying a number, and the approval handler answers it even
 * when the queue is empty.
 *
 * WHY REGISTRATION IS LAST. The first two handlers claim only words they recognise
 * exactly. M7's does something none of the others do: inside an open check-in window it
 * also claims a message it CANNOT read, answering it with the re-ask menu (bounded to
 * one per window by `reasked_at`). A handler that claims unreadable messages placed
 * ahead of one that matches exact words would starve it — a parent texting "done" about
 * their OHIP paperwork during an open registration window would get "how did
 * registration go?" and their answer would go unfiled. Narrow before broad puts each
 * word with the handler that actually recognises it, and leaves M7 exactly where its own
 * module note puts it: last before the conversational layer.
 */

/**
 * C1's own approval grammar, resolved against the app's approve/decline/undo spine.
 * Declines anything that is not a command, and anything that is a command with nothing
 * to command — see {@link resolveApproval}.
 */
export function approvalHandler(spine: ApprovalSpine): DeterministicHandler {
  return {
    name: 'approval',
    async handle(database: Database, ctx: HandlerContext): Promise<HandlerVerdict> {
      const command = matchFastPath(ctx.body);
      if (!command) return { claimed: false };

      const outcome = await resolveApproval(
        database,
        {
          familyId: ctx.familyId,
          parentUserId: ctx.parentUserId,
          command,
          now: ctx.now,
        },
        spine,
      );
      if (outcome.status === 'declined_to_claim') return { claimed: false };
      return { claimed: true, outcome: outcome.status, reply: outcome.reply };
    },
  };
}

/**
 * M8's health-nudge replies. Two outcomes reach a parent: the paperwork is filed as
 * handled, or a checkup is DRAFTED for their approval — Hale never books (rule #4), and
 * the reply says so rather than implying an appointment exists.
 *
 * M8 shipped this handler with no caller; C1 is its first one, which is why the two
 * acknowledgement lines live in C1's copy rather than M8's.
 */
export function healthReplyHandler(deps: HealthReplyDeps): DeterministicHandler {
  return {
    name: 'health',
    async handle(database: Database, ctx: HandlerContext): Promise<HandlerVerdict> {
      const outcome = await handleHealthCheckpointReply(
        database,
        { familyId: ctx.familyId, parentUserId: ctx.parentUserId, body: ctx.body },
        deps,
      );
      switch (outcome.status) {
        case 'recorded_done':
          return { claimed: true, outcome: outcome.status, reply: healthDoneReply() };
        case 'drafted_for_approval':
          return { claimed: true, outcome: outcome.status, reply: checkupDraftedReply() };
        default:
          return { claimed: false };
      }
    },
  };
}

/**
 * M7's registration check-in replies — "we got in", "waitlisted #3", "missed it".
 *
 * Unlike the two above, this one renders its own copy (the outcome shapes carry a
 * `reply`), so the adapter passes it through untouched: the 36-hour waitlist clock and
 * the sentence describing it are set in the same call, and a second copy here could
 * disagree with the deadline actually stored.
 *
 * THE RE-ASK IS THE COACH'S NOW (VIL-221 · C2), which is what M7's own module note said
 * should happen the moment a conversational layer existed. Until C2 the check-in menu
 * was the best answer available to an unreadable message; now it is the worst, because
 * an unreadable message is overwhelmingly a parent asking Hale something rather than
 * reporting a registration outcome in words M7 does not know. So `reasked` returns
 * `claimed: false` and the turn falls through to the model.
 *
 * `recorded` is still claimed, and that asymmetry is the whole point: the three
 * certainties M7 CAN read start a 36-hour clock and must never be paraphrased by a
 * model, while everything it cannot read was never M7's to answer.
 *
 * The stamp is still spent on the way past — `handleSequenceReply` writes `reasked_at`
 * before returning `reasked`, and that is left alone deliberately. It belongs to M7's
 * window bookkeeping, it costs the family nothing now that both branches fall through
 * to the coach, and reaching into M7 to suppress it would put a second opinion about
 * the window's state in a module that does not own one.
 */
export function sequenceReplyHandler(deps: SequenceReplyDeps): DeterministicHandler {
  return {
    name: 'registration',
    async handle(database: Database, ctx: HandlerContext): Promise<HandlerVerdict> {
      const outcome = await handleSequenceReply(
        database,
        { familyId: ctx.familyId, body: ctx.body, now: ctx.now },
        deps,
      );
      if (outcome.status !== 'recorded') return { claimed: false };
      return { claimed: true, outcome: outcome.status, reply: outcome.reply };
    },
  };
}
