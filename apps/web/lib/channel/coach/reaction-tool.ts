import { AGENT_TOOL_ACTION_PREFIX, type RegisteredTool, type Skill, defineTool } from '@hale/agent';
import { z } from 'zod';
import { type ParentReaction, readParentReaction } from '~/lib/channel/linq/tapback';

/**
 * VIL-680 — the model's choice of a tapback on the message the parent just sent.
 *
 * The model writes its reply exactly as always and calls this verb when a reaction fits,
 * saying whether the reaction alone is the whole answer. Nothing is sent here: the choice
 * rides out on the turn result and the router decides what goes (router/reaction-plan.ts),
 * after every tool of the turn has finished. No word list and no fallback emoji: a name
 * Linq cannot send is handed back to the model to fix or drop.
 *
 * Registered only on a 1:1 iMessage turn the router lit (`ChannelTurn.reactions`), so the
 * dark skill, its tool list and the eval cache stay byte-identical. The lit turn also
 * appends `coach-reaction`, which says when a reaction fits and when it is enough.
 */

export const REACT_TOOL = 'react_to_parent_message';

export interface ReactionChoice {
  reaction: ParentReaction;
  /** The reaction is the whole answer and the written reply is not sent. */
  alone: boolean;
}

export function reactToParentMessageTool(args: {
  onReact: (choice: ReactionChoice) => void;
}): RegisteredTool {
  return defineTool({
    name: REACT_TOOL,
    description:
      'Put one tapback on the message the parent just sent. `reaction` is love, like, laugh, emphasize, question or dislike, or else exactly one emoji (older iPhones show an emoji tapback as a text, so prefer the six). `alone: true` sends only the tapback, not your reply. Still write the reply to the parent, as if it were going. One tapback per message; the last call wins.',
    inputSchema: z.object({ reaction: z.string(), alone: z.boolean() }),
    inputExamples: [
      { reaction: 'love', alone: true },
      { reaction: 'like', alone: false },
    ],
    monetary: false,
    registersOnly: true,
    // Reads no child row and holds no words.
    touchesChildContent: false,
    handler: async (input) => {
      const reaction = readParentReaction(input.reaction);
      if (!reaction) {
        throw new Error(
          `That reaction cannot be sent. Use love, like, laugh, emphasize, question or dislike, or exactly one emoji, and call ${REACT_TOOL} again, or leave the reaction out.`,
        );
      }
      args.onReact({ reaction, alone: input.alone });
      return { registered: true as const };
    },
  });
}

/**
 * Lit only: list the verb and append the reaction addendum. `null` (dark, or not a 1:1
 * iMessage turn) returns the same skill object, so the disk bytes and the eval cache stay.
 */
export function augmentCoachSkillForReactions(skill: Skill, addendum: Skill | null): Skill {
  if (addendum === null || skill.meta.tools.includes(REACT_TOOL)) return skill;
  return {
    ...skill,
    meta: { ...skill.meta, tools: [...skill.meta.tools, REACT_TOOL] },
    instructions: `${skill.instructions}\n\n${addendum.instructions}`,
  };
}

/**
 * Whether an audited call is a tool other than this verb. The runtime counts them, because
 * a turn whose tools ran keeps its words (router/reaction-plan.ts); a refused call counts
 * too.
 */
export function isOtherToolCall(actionTaken: string): boolean {
  return actionTaken !== `${AGENT_TOOL_ACTION_PREFIX}${REACT_TOOL}`;
}
