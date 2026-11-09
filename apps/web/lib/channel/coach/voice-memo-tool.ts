import { type RegisteredTool, type Skill, defineTool } from '@hale/agent';
import { z } from 'zod';

/**
 * VIL-495 — the model's choice to say this reply as a voice memo (wire: VIL-476 / #963).
 *
 * The model writes the reply exactly as a text, then calls this verb when that reply
 * would land better spoken. Nothing here holds copy or a keyword: the verb takes no
 * argument, and what is spoken is the reply the model wrote. Whether a memo can actually
 * go (1:1 iMessage, capability, TTS) is decided at send time by `sendReplyAsVoiceMemo`;
 * every "no" there sends the same reply as text.
 *
 * Registered only while `LINQ_VOICE_MEMOS_ENABLED` is lit, on a 1:1 turn, so the dark
 * skill, its tool list and the eval cache stay byte-identical. The lit turn also appends
 * `coach-voice-memo`, which says when a memo fits and names an inbound memo.
 */

export const VOICE_MEMO_TOOL = 'reply_as_voice_memo';

export function replyAsVoiceMemoTool(args: { onChoose: () => void }): RegisteredTool {
  return defineTool({
    name: VOICE_MEMO_TOOL,
    description:
      'Call this when the reply you are writing should reach the parent as a voice memo in your voice instead of a text. Write the reply exactly as you would text it; that same reply is what is spoken. Do not call it for a short fact to scan, a link, or a group chat.',
    inputSchema: z.object({}),
    monetary: false,
    registersOnly: true,
    // Reads no child row; the spoken reply is the one that passed the teen floor.
    touchesChildContent: false,
    handler: async () => {
      args.onChoose();
      return { registered: true as const };
    },
  });
}

/**
 * Lit only: list the verb and append the voice-memo addendum. `null` (dark, or a group
 * turn) returns the same skill object, so the 1:1 disk bytes and the eval cache stay put.
 */
export function augmentCoachSkillForVoiceMemos(skill: Skill, addendum: Skill | null): Skill {
  if (addendum === null || skill.meta.tools.includes(VOICE_MEMO_TOOL)) return skill;
  return {
    ...skill,
    meta: { ...skill.meta, tools: [...skill.meta.tools, VOICE_MEMO_TOOL] },
    instructions: `${skill.instructions}\n\n${addendum.instructions}`,
  };
}
