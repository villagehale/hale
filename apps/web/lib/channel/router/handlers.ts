import type { Database } from '@hale/db';
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
