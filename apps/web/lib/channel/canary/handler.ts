import { type Database, schema } from '@hale/db';
import type { DeterministicHandler, HandlerContext, HandlerVerdict } from '../router/route';
import { CANARY_ANSWERED_ACTION, isCanaryTurn } from './config';

/**
 * The canary's own handler, and it is LAST in the chain on purpose.
 *
 * Being last is the whole mechanism. A turn that reaches it has already run
 * GATE 0's turn-ledger read, GATE 1's role gate, the thread append, GATE 2a's
 * disambiguation select, and the DECLINE PATH of every other handler —
 * including the registration handler, whose reader is where a whole night's
 * texts actually crashed (#617: a bound Date in `loadAwaitingSequence` threw at
 * serialization before the statement was even sent, for ANY family). A canary
 * placed first would have exited at GATE 2 and stayed green all night.
 *
 * It answers for itself (`reply: null`): no send, no claimAnswer, no model, no
 * hourly budget. That contract means the router writes NOTHING down for this
 * turn — `deliver()` returns before the turn ledger is touched — so the audit
 * row below is not bookkeeping beside the answer, it IS the answer. The cron's
 * next tick reads exactly this row (run.ts) and pages when it is missing, which
 * is also what rule #6 requires of any action at all.
 */
export function inboundCanaryHandler(): DeterministicHandler {
  return {
    name: 'inbound_canary',
    async handle(database: Database, ctx: HandlerContext): Promise<HandlerVerdict> {
      if (!(await isCanaryTurn(database, ctx.body, ctx.familyId))) return { claimed: false };

      // Walked, not needed: this is the reader GATE 2b would consult, and a
      // probe that skipped it would stop covering the one stage between the
      // handlers and the coach.
      await ctx.openQuestions();

      await database.insert(schema.auditLog).values({
        familyId: ctx.familyId,
        actor: ctx.parentUserId,
        actionTaken: CANARY_ANSWERED_ACTION,
        targetTable: 'channel_messages',
        targetId: ctx.inboundChannelMessageId,
      });

      return { claimed: true, outcome: 'canary_answered', reply: null };
    },
  };
}
