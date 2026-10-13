import { type Skill, defineTool } from '@hale/agent';
import type { ActionType } from '@hale/types';
import { AUTONOMY_ALLOWED_KINDS } from '@hale/worker/autonomy-gate';
import type { AutonomyRevocation } from '@hale/worker/memory-writer';
import { z } from 'zod';

export const TURN_OFF_AUTONOMY_TOOL = 'turn_off_autonomy';

export interface AutonomySwitchOffPorts {
  /** The parent's own message this turn, kept beside the model's reading as evidence. */
  parentWords: string;
  revoke: (input: {
    familyId: string;
    actorUserId: string;
    kind: ActionType;
    evidence: { parentWords: string; interpretation: string };
  }) => Promise<AutonomyRevocation>;
}

/**
 * The switch-off (Barton, 2026-10-11): one parent message, in any wording or language,
 * turns Hale's autonomy off for the kinds it names. The model reads the intent and picks
 * the kinds; nothing here matches words. The reply that confirms it is the model's own.
 */
export function turnOffAutonomyTool(ports: AutonomySwitchOffPorts) {
  return defineTool({
    name: TURN_OFF_AUTONOMY_TOOL,
    description:
      'Stop Hale doing a kind of action ON ITS OWN, for this family. Call this when the parent, in any words or language, asks you to stop doing something without asking them first — for example to stop emailing on their behalf (send_email and reply_to_email). Do not call it when they complain about, or want to fix or undo, one thing you did: that is about that one action, not about whether you act on your own. `kinds` are the action kinds they mean. `interpretation` is one sentence, in English, saying what you understood them to ask. After `revoked`, tell them in your own words that you will now ask before doing that. After `not_a_parent`, tell them only a parent can change that.',
    inputSchema: z.object({
      kinds: z.array(z.enum(AUTONOMY_ALLOWED_KINDS as [ActionType, ...ActionType[]])).min(1),
      interpretation: z.string().min(1).max(300),
    }),
    inputExamples: [
      {
        kinds: ['send_email', 'reply_to_email'],
        interpretation: 'They want Hale to stop sending email for them without asking.',
      },
    ],
    monetary: false,
    touchesChildContent: false,
    handler: async (input, ctx) => {
      const kinds = [...new Set(input.kinds)];
      for (const kind of kinds) {
        const revoked = await ports.revoke({
          familyId: ctx.familyId,
          actorUserId: ctx.actor,
          kind,
          evidence: { parentWords: ports.parentWords, interpretation: input.interpretation },
        });
        if (revoked.outcome === 'not_a_parent') return { outcome: 'not_a_parent' as const };
      }
      return { outcome: 'revoked' as const, kinds };
    },
  });
}

/**
 * The coach skill on disk does not name this tool, so its bytes (and the channel eval's
 * cache keys) stay put for every family Hale does nothing on its own for. A family with
 * an autonomy grant gets the tool name listed; the runtime always registers the tool.
 */
export function augmentCoachSkillForAutonomySwitchOff(skill: Skill, hasGrant: boolean): Skill {
  if (!hasGrant || skill.meta.tools.includes(TURN_OFF_AUTONOMY_TOOL)) return skill;
  return {
    ...skill,
    meta: { ...skill.meta, tools: [...skill.meta.tools, TURN_OFF_AUTONOMY_TOOL] },
  };
}
