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
  /**
   * The model's own words, written now, for the group if the leave is refused AFTER the
   * goodbye went out (a member left, Linq refused). Hale cannot speak after it leaves,
   * so the goodbye has to go first; this line is what keeps the goodbye from becoming a
   * lie. No fixed copy: the model writes it in the group's language.
   */
  ifLeaveFails: string;
}

/**
 * Design lock (Devin SEC flag): a leave is grounded in what a member actually sent THIS
 * turn, never in an ask the model only claims to have heard. Normalized containment:
 * case, punctuation, quotes and whitespace are ignored; the words must be there.
 */
export function normalizeForAsk(text: string): string {
  return text
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function askIsGrounded(ask: string, memberWords: string): boolean {
  const a = normalizeForAsk(ask);
  const m = normalizeForAsk(memberWords);
  return a.length > 0 && m.length > 0 && ` ${m} `.includes(` ${a} `);
}

/** Why the guard would decline a leave, as the model reads it. Facts only, no copy. */
export type GroupLeaveRefusal = 'too_small' | 'not_group' | 'flag_off' | 'unavailable';

const STAYING_WHY: Record<GroupLeaveRefusal, string> = {
  too_small:
    'This group is too small to leave: you can only leave a group with at least 3 other people in it (4+ participants including you).',
  not_group: 'This chat is not a group chat, so there is nothing to leave.',
  flag_off: 'Leaving group chats is not available right now.',
  unavailable: 'The chat could not be checked right now, so you did not leave.',
};

export function leaveGroupChatTool(args: {
  /** The member's message this turn — the only words a leave may be grounded in. */
  memberWords: string;
  onLeave: (intent: GroupLeaveIntent) => void;
  /**
   * The router's guard, run BEFORE the reply is written. Absent: the intent registers
   * and the router's guard decides after the send (old behaviour).
   */
  check?: () => Promise<{ ok: true } | { ok: false; reason: GroupLeaveRefusal }>;
}): RegisteredTool {
  return defineTool({
    name: GROUP_LEAVE_TOOL,
    description:
      "Leave THIS group chat, permanently, after your reply. Call it ONLY when a member of this group has plainly asked you (Hale) to leave or get out of this chat — not when someone is annoyed, asks you to be quiet, stops a topic, or asks to stop texts (that is STOP, handled elsewhere). If the ask is ambiguous, ask them first instead of calling this. `ask` is the member's own words asking you to leave, copied exactly from THEIR message this turn (not paraphrased, not from earlier). `ifLeaveFails` is one short line in your own words for the group if the leave is refused after your goodbye goes out: say you could not leave and are still here. Your reply this turn is the last thing the group sees from you: write a short goodbye in your own words and the group's language, and say a member can add you back any time. Call it BEFORE writing your reply and read its result: if it returns `stillInChat: true`, you did NOT leave — tell the group you are staying and why, never say you are leaving. Never promise a leave already happened.",
    inputSchema: z.object({ ask: z.string().min(1), ifLeaveFails: z.string().min(1) }),
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
      if (!askIsGrounded(ask, args.memberWords)) {
        // Nothing registered: no member said this in this turn's message.
        return {
          left: false as const,
          stillInChat: true as const,
          reason: 'not_asked_this_turn' as const,
          note: `The words in \`ask\` are not in the member's message this turn, so you did NOT leave and will NOT leave. Only leave when this turn's message itself asks you to; if they meant it, they can say so. Do not say you are leaving.`,
        };
      }
      const ifLeaveFails = (input.ifLeaveFails ?? '').trim();
      if (ifLeaveFails === '') {
        throw new Error(
          'Write `ifLeaveFails`: your own line for the group if the leave is refused after your goodbye.',
        );
      }
      const guard = args.check ? await args.check() : ({ ok: true } as const);
      if (!guard.ok) {
        // Nothing registered: the router will not try to leave. The model must not
        // say it left — it is still in this chat.
        return {
          left: false as const,
          stillInChat: true as const,
          reason: guard.reason,
          why: STAYING_WHY[guard.reason],
          note: 'You did NOT leave and will NOT leave this chat. You are still in it. Do not say you are leaving or have left; tell the group honestly you are staying and why, in your own words.',
        };
      }
      args.onLeave({ ask, ifLeaveFails });
      return {
        registered: true as const,
        left: false as const,
        willLeaveAfterReply: true as const,
      };
    },
  });
}

/** Lit only: list the verb in the skill's tool allowlist. Dark leaves the skill untouched. */
export function augmentCoachSkillForGroupLeave(skill: Skill, enabled: boolean): Skill {
  if (!enabled || skill.meta.tools.includes(GROUP_LEAVE_TOOL)) return skill;
  return { ...skill, meta: { ...skill.meta, tools: [...skill.meta.tools, GROUP_LEAVE_TOOL] } };
}
