import { type Database, type UnmetIntentCategory, type UnmetIntentLane, schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import type { AgentClient } from '@hale/agent';
import {
  type GeneralAnswerComposer,
  type GeneralAnswerFallback,
  createGeneralAnswer,
} from './answer';
import { ANSWER_UNAVAILABLE_REPLY, PROVIDER_ACCESS_REPLY, SAFETY_REPLY } from './copy';
import {
  type InboundLaneScreen,
  type LaneScreenFallback,
  createInboundLaneScreen,
} from './screen';

/**
 * VIL-273 — the off-domain capability lane, end to end minus the sending.
 *
 * Three kinds of text have an answer that the full coach turn does not improve: a
 * question about the world, a question about a symptom, and a parent trying to get a
 * doctor. This module turns one inbound message into whichever of those it is, the
 * answer that ends it, and a countable demand signal — and the router does the rest.
 *
 * BOUNDARY V3 (founder-locked 2026-08-11) moved ONE of those three. The quiet-operator
 * promise governs OUTBOUND: Hale never starts the chatter. Inbound it had been applied
 * too widely, and a parent who asked who the best striker is got charm and a closed
 * door — which reads as a product that CANNOT rather than one that chooses not to. So
 * `off_domain_general` now composes one brief, honest answer (see answer.ts) and stops
 * there. The other two do not move: a symptom still gets the fixed 811/911 line and a
 * parent hunting a paediatrician still gets Health Care Connect, both from copy.ts,
 * both untouched by any model.
 *
 * WHY `status: 'deflected'` KEPT ITS NAME. It is the router's outcome enum and the
 * founder's X1 log taxonomy — it means "this lane finished the turn, no coach was
 * woken", which is still exactly what happened. What the parent actually received is
 * carried honestly beside it in {@link OffDomainVerdict.replySource}, and renaming a
 * logged enum to describe one of its three branches would cost the weekly counts their
 * history for no reader's benefit.
 *
 * WHY THE SIGNAL LIVES HERE AND NOT IN THE ROUTER. This lane is where Hale learns what
 * parents bring it that its own job does not cover, and the ONE thing worth knowing is
 * what was asked. Recording that is not the router's business (it deals in threads,
 * ledgers and audit rows); it is the last step of the lane's own decision. Keeping the
 * two in one call is also what makes the count trustworthy: there is no path that
 * answers off-domain without producing a signal, because it is the same return value —
 * and that stayed true through the flip, so the digest keeps counting (the bucket now
 * reads "questions parents ask us", which is if anything the more useful signal).
 *
 * Rule #11 all the way down. The screen's degraded paths come back NAMED
 * ({@link LaneScreenFallback}), the composer's come back NAMED
 * ({@link GeneralAnswerFallback}) and ride out in `replySource`, the record's outcome
 * comes back NAMED ({@link UnmetSignalOutcome}), and none of them can be silent. A
 * signal that failed to write must never cost a parent their reply, so the write is
 * best-effort and says so out loud rather than throwing.
 */

/** Whether the demand signal actually landed. `not_recorded` is a real, countable
 * outcome — the deflection still went out, and the founder's weekly count is short one
 * row that the log line accounts for. */
export type UnmetSignalOutcome = 'recorded' | 'not_recorded';

/**
 * Where the words that went out came from. `fixed` is one of the two door lines in
 * copy.ts; `composed` is the general answer; anything else is a
 * {@link GeneralAnswerFallback} naming why the composer could not run and the deflect
 * line stood in for it (rule #11).
 */
export type ReplySource = 'fixed' | 'composed' | GeneralAnswerFallback;

export type OffDomainVerdict =
  /** Hale's job. The turn continues to the coach exactly as it did before this stage
   * existed — carrying WHY, when the screen could not run (rule #11). */
  | { status: 'in_domain'; fallback: LaneScreenFallback | null }
  /** The lane finished the turn itself. See the module note on why this kept its name
   * now that one of the three branches is an answer rather than a refusal. */
  | {
      status: 'deflected';
      lane: UnmetIntentLane;
      category: UnmetIntentCategory;
      reply: string;
      replySource: ReplySource;
      signal: UnmetSignalOutcome;
    };

export interface OffDomainPorts {
  screen: InboundLaneScreen;
  /** Writes the one brief answer to a question about the world. Non-nullable (rule
   * #11): "no composer wired" is not a state this lane has — a composer that cannot run
   * says so by name and the fixed line goes out instead. */
  answer: GeneralAnswerComposer;
  /** Stamps the inbound row with the lane + bucket. Never throws — see
   * {@link UnmetSignalOutcome}. */
  recordUnmetIntent(input: {
    channelMessageId: string;
    familyId: string;
    lane: UnmetIntentLane;
    category: UnmetIntentCategory;
  }): Promise<UnmetSignalOutcome>;
}

export interface OffDomainLane {
  consider(input: {
    familyId: string;
    channelMessageId: string;
    text: string;
  }): Promise<OffDomainVerdict>;
}

export function offDomainLane(ports: OffDomainPorts): OffDomainLane {
  return {
    async consider(input) {
      const reading = await ports.screen.read(input.text);
      if (reading.lane === 'in_domain' || reading.category === null) {
        return { status: 'in_domain', fallback: reading.fallback };
      }
      const lane = reading.lane;

      // The two doors are fixed sentences and the composer is never woken for them. Not
      // a prompt asked nicely to decline — a branch it cannot reach. Letting a model
      // anywhere near what a parent is told about their child's head injury is the
      // failure this shape makes impossible rather than merely discouraged.
      const { reply, replySource } =
        lane === 'safety_critical'
          ? { reply: SAFETY_REPLY, replySource: 'fixed' as const }
          : lane === 'provider_access'
            ? { reply: PROVIDER_ACCESS_REPLY, replySource: 'fixed' as const }
            : await answerOrFallback(ports, input.text);

      const signal = await ports.recordUnmetIntent({
        channelMessageId: input.channelMessageId,
        familyId: input.familyId,
        lane,
        category: reading.category,
      });

      return {
        status: 'deflected',
        lane,
        category: reading.category,
        reply,
        replySource,
        signal,
      };
    },
  };
}

/**
 * The general terminal: the composed answer, or the honest line when it could not be
 * written.
 *
 * The parent always gets SOMETHING — that is the whole contract. What they get on the
 * failure branch says what actually happened rather than reciting a boundary, because
 * under v3 there is no boundary here to recite: the same question tomorrow gets a real
 * answer, and a line claiming otherwise would be the one false thing in the exchange.
 */
async function answerOrFallback(
  ports: OffDomainPorts,
  text: string,
): Promise<{ reply: string; replySource: ReplySource }> {
  const composed = await ports.answer.compose(text);
  if (composed.status === 'composed') return { reply: composed.reply, replySource: 'composed' };
  // A question about the world that turned out to be about a hurt child. It leaves by
  // the same door a screened symptom does, words and all, and `fixed` says so — crediting
  // the composer for a sentence it did not write would cost the founder's weekly count
  // the one distinction it is for (skill audit P0 #3).
  if (composed.status === 'safety') return { reply: SAFETY_REPLY, replySource: 'fixed' };
  return { reply: ANSWER_UNAVAILABLE_REPLY, replySource: composed.reason };
}

/**
 * The demand-signal write: two columns on the inbound row the parent's message already
 * occupies (migration 0080).
 *
 * The family id is in the WHERE clause as well as the id, matching the router's own
 * rule-#1 backstop in loadInboundContext: the only thing asserting whose message this
 * is came off a queue, and a mismatch must stamp nothing rather than attribute one
 * family's question to another's week.
 *
 * Best-effort by construction. This is telemetry sitting between a parent's question
 * and Hale's answer; a dead index or a locked row is not a reason for them to hear
 * nothing back, so the failure is caught, named and counted rather than thrown. The
 * catch is deliberately broad for that reason and that reason only — it is the boundary,
 * not business logic.
 */
export function recordUnmetIntent(database: Database) {
  return async (input: {
    channelMessageId: string;
    familyId: string;
    lane: UnmetIntentLane;
    category: UnmetIntentCategory;
  }): Promise<UnmetSignalOutcome> => {
    try {
      const updated = await database
        .update(schema.channelMessages)
        .set({ unmetLane: input.lane, unmetCategory: input.category })
        .where(
          and(
            eq(schema.channelMessages.id, input.channelMessageId),
            eq(schema.channelMessages.familyId, input.familyId),
          ),
        )
        .returning({ id: schema.channelMessages.id });
      if (updated.length > 0) return 'recorded';
      console.error(
        { channelMessageId: input.channelMessageId, lane: input.lane },
        'off-domain lane: unmet-intent stamp matched no row',
      );
      return 'not_recorded';
    } catch (err) {
      console.error(
        { err: err instanceof Error ? err.message : 'unknown', lane: input.lane },
        'off-domain lane: unmet-intent stamp failed',
      );
      return 'not_recorded';
    }
  };
}

/**
 * The production lane. Both model stages share ONE client resolver — they are two calls
 * on the same turn, and a screen that could reach Anthropic while the composer could not
 * is not a state worth being able to represent.
 *
 * It used to take a `pendingApprovals` reader as well, bound to the approvals query so
 * the count in the deflect could never disagree with the list a "YES 1" would hit. The
 * count is gone with the append that printed it (skill audit P0 #4: nothing Hale texts
 * points at the app), and the reader went with it rather than staying wired to nothing.
 */
export function productionOffDomainLane(
  database: Database,
  client: () => AgentClient,
): OffDomainLane {
  return offDomainLane({
    screen: createInboundLaneScreen(client),
    answer: createGeneralAnswer(client),
    recordUnmetIntent: recordUnmetIntent(database),
  });
}
