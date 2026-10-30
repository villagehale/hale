import { type RegisteredTool, type Skill, defineTool } from '@hale/agent';
import { z } from 'zod';

/**
 * VIL-477 — the product path for Hale leaving a family group chat (wire: group-leave.ts).
 *
 * Hale's AI decides whether a member in THIS group plainly asked Hale to leave the chat,
 * and writes the goodbye itself (its own words, the family's language — nothing here
 * holds copy). Calling this verb only registers the intent; the router sends the
 * model's reply first and then calls `leaveGroupOnFamilyAsk`, which still owns the
 * guards (flag, Linq's 4+ participant floor). A leave the guard declines changes
 * nothing the family sees beyond the reply the model already wrote.
 *
 * Registered only while `LINQ_GROUP_LEAVE_ENABLED` is lit, on a group turn, so the dark
 * skill, its tool list and the eval cache stay byte-identical to main.
 */

export const GROUP_LEAVE_TOOL = 'leave_group_chat';

export interface GroupLeaveIntent {
  /** The member's own words asking Hale to leave, as the model quoted them. */
  ask: string;
}

export function leaveGroupChatTool(args: {
  onLeave: (intent: GroupLeaveIntent) => void;
}): RegisteredTool {
  return defineTool({
    name: GROUP_LEAVE_TOOL,
    description:
      "Leave THIS group chat, permanently, after your reply. Call it ONLY when a member of this group has plainly asked you (Hale) to leave or get out of this chat — not when someone is annoyed, asks you to be quiet, stops a topic, or asks to stop texts (that is STOP, handled elsewhere). If the ask is ambiguous, ask them first instead of calling this. `ask` is the member's own words asking you to leave, quoted exactly. Your reply this turn is the last thing the group sees from you: write a short goodbye in your own words and the group's language, and say a member can add you back any time. Leaving can be declined (very small groups cannot be left); never promise it already happened.",
    inputSchema: z.object({ ask: z.string().min(1) }),
    monetary: false,
    registersOnly: true,
    touchesChildContent: false,
    handler: async (input) => {
      const ask = input.ask.trim();
      if (ask === '') {
        throw new Error(
          `Quote the member's words asking you to leave in \`ask\`. If nobody plainly asked, do not call ${GROUP_LEAVE_TOOL}.`,
        );
      }
      args.onLeave({ ask });
      return { registered: true as const };
    },
  });
}

/** Lit only: list the verb in the skill's tool allowlist. Dark leaves the skill untouched. */
export function augmentCoachSkillForGroupLeave(skill: Skill, enabled: boolean): Skill {
  if (!enabled || skill.meta.tools.includes(GROUP_LEAVE_TOOL)) return skill;
  return { ...skill, meta: { ...skill.meta, tools: [...skill.meta.tools, GROUP_LEAVE_TOOL] } };
}
