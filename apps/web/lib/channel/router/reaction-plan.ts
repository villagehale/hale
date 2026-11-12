import type { ReactionChoice } from '~/lib/channel/coach/reaction-tool';
import type { ChannelMessageReceivedJob } from '~/lib/channel/inbound-route';
import { type ParentReaction, linqReactionsEnabled } from '~/lib/channel/linq/tapback';
import type { ReplyRoute } from './reply-route';

/**
 * VIL-680 · what the router does with the tapback the coach chose. Pure.
 *
 * The model picks whether to react, which reaction, and whether it is the whole answer.
 * Code holds no word list: it only refuses "the whole answer" on facts it can see. A turn
 * whose tools ran, that owes a ledger row, or that exists to ask which question was meant
 * keeps its words, and the reaction goes beside them.
 */

/** Why there is no reaction on this turn at all. */
export type NoReaction =
  | 'not_chosen'
  /** The claim gate asked the coach again; the words it reacted beside are not the ones
   * that go. */
  | 'reasked'
  /** One reaction per answer, and an answer of several bubbles is not v1's. */
  | 'several_bubbles'
  /** The reply is spoken, and a memo is never a reaction's companion. */
  | 'voice_memo';

/** Why the reaction cannot stand for the words, so both go. */
export type AloneRefusal = 'tools_ran' | 'owes_rows' | 'unplaced_answer';

export type ReactionPlan =
  | { kind: 'none'; reason: NoReaction }
  | { kind: 'beside'; reaction: ParentReaction; why: 'not_asked' | AloneRefusal }
  /** The reaction is the answer; `standsFor` is the gated reply it replaces, which is
   * never sent. A fold that changes those words keeps them (linq/moments.ts). */
  | { kind: 'alone'; reaction: ParentReaction; standsFor: string };

/**
 * Whether this turn may carry a reaction: lit for the family, a 1:1 chat Linq said is
 * iMessage (RCS and SMS refuse a tapback), and a parent message for it to land on.
 */
export function reactionsLitFor(
  route: ReplyRoute,
  job: Pick<ChannelMessageReceivedJob, 'family_id' | 'in_group'>,
): boolean {
  return (
    route.channel === 'imessage' &&
    route.service === 'iMessage' &&
    job.in_group === false &&
    route.replyToMessageId !== null &&
    linqReactionsEnabled(job.family_id)
  );
}

export function planParentReaction(input: {
  /** The coach's choice and how many other tools its turn ran, or null for none. */
  choice: (ReactionChoice & { otherToolCalls: number }) | null;
  voiceMemo: boolean;
  /** How many times the coach was asked (composeReconciledReply). */
  attempts: number;
  /** Registration-watch rows the reply's words owe after the send. */
  mints: number;
  /** The turn answers Hale's "which one?" (runAgentTurn.unplacedAnswer). */
  unplacedAnswer: boolean;
  /** The gated answer, as the bubbles it goes out as. */
  bubbles: readonly string[];
}): ReactionPlan {
  const { choice } = input;
  if (!choice) return { kind: 'none', reason: 'not_chosen' };
  if (input.attempts > 1) return { kind: 'none', reason: 'reasked' };
  const [words, ...more] = input.bubbles;
  if (words === undefined || more.length > 0) return { kind: 'none', reason: 'several_bubbles' };
  if (input.voiceMemo) return { kind: 'none', reason: 'voice_memo' };
  const why: 'not_asked' | AloneRefusal | null = !choice.alone
    ? 'not_asked'
    : choice.otherToolCalls > 0
      ? 'tools_ran'
      : input.mints > 0
        ? 'owes_rows'
        : input.unplacedAnswer
          ? 'unplaced_answer'
          : null;
  if (why) return { kind: 'beside', reaction: choice.reaction, why };
  return { kind: 'alone', reaction: choice.reaction, standsFor: words };
}
