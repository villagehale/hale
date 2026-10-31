import { pickLane } from '@hale/agent';
import { z } from 'zod';
import { loadCronSkill } from '~/lib/cron/skill';
import { voiceClient } from '~/lib/loop/voice/compose';
import { HOT_SMS_CLIENT_OPTIONS, budgetedAnthropic } from '~/lib/pipeline/client';
import { forceToolJson } from '~/lib/pipeline/structured';
import type { GroupPlanRsvpLineInput } from './facts';
import type { GroupPollLineInput } from './poll-facts';

/**
 * VIL-442 (T15) — the model writes one group-plan line from facts. VIL-471
 * polls use the same composer with their own skill (`input.skill`).
 *
 * No fallback sentence. A line the model could not write is named
 * `voice_unavailable` / `model_failed` / `unusable` and nothing is sent.
 */

export type GroupPlanRsvpVoiceSource = 'composed' | 'retry';

export type GroupPlanRsvpVoiceSkip =
  | 'voice_unavailable'
  | 'skill_unavailable'
  | 'model_failed'
  | 'unusable';

export type GroupLineInput = GroupPlanRsvpLineInput | GroupPollLineInput;

export interface GroupPlanRsvpComposer {
  compose(
    input: GroupLineInput,
    options?: { prompt?: 'full' | 'short' },
  ): Promise<{ line: string }>;
}

export const GROUP_PLAN_RSVP_VOICE_MAX_TOKENS = 400;

/** One model-written line. Code never stitches parts of a message together. */
export const GROUP_PLAN_RSVP_VOICE_TOOL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    send: { type: 'boolean' },
    line: { type: 'string' },
    why: { type: 'string' },
  },
  required: ['send', 'line'],
} as const;

const voiceAnswerSchema = z.object({
  send: z.boolean(),
  line: z.string(),
  why: z.string().optional(),
});

function lineUsable(line: string, input: GroupLineInput): boolean {
  if (!line.trim()) return false;
  if (/https?:\/\//i.test(line)) return false;
  if (input.questions === 1 && !line.includes('?')) return false;
  if (input.questions === 0 && line.includes('?')) return false;
  return true;
}

export function productionGroupPlanRsvpComposer(): GroupPlanRsvpComposer | undefined {
  if (!process.env.ANTHROPIC_API_KEY || process.env.VOICE_DISABLED === 'true') return undefined;
  return {
    async compose(input, options) {
      const skill = await loadCronSkill(input.skill);
      const client = voiceClient() ?? budgetedAnthropic(HOT_SMS_CLIENT_OPTIONS);
      const result = await forceToolJson({
        client,
        lane: pickLane(skill.meta.task),
        system: skill.instructions,
        userMessage: JSON.stringify({ ...input, retry: options?.prompt === 'short' }),
        toolName: 'send_group_line',
        toolDescription: 'The one message Hale sends.',
        inputJsonSchema: GROUP_PLAN_RSVP_VOICE_TOOL_SCHEMA,
        schema: voiceAnswerSchema,
        maxTokens: options?.prompt === 'short' ? 160 : GROUP_PLAN_RSVP_VOICE_MAX_TOKENS,
      });
      if (!result.value.send) throw new Error('group line voice: send false');
      return { line: result.value.line };
    },
  };
}

export async function composeGroupPlanRsvpLine(
  input: GroupLineInput,
  composer: GroupPlanRsvpComposer | undefined,
): Promise<
  | { status: 'composed'; source: GroupPlanRsvpVoiceSource; line: string }
  | { status: 'skipped'; reason: GroupPlanRsvpVoiceSkip }
> {
  if (!composer) return { status: 'skipped', reason: 'voice_unavailable' };
  const attempt = async (prompt: 'full' | 'short'): Promise<{ line: string } | null> => {
    try {
      const spoken = await composer.compose(input, { prompt });
      return lineUsable(spoken.line, input) ? spoken : null;
    } catch (err) {
      console.warn(
        { prompt, err: err instanceof Error ? err.name : 'unknown' },
        'group plan rsvp voice: compose failed',
      );
      return null;
    }
  };
  const first = await attempt('full');
  if (first) return { status: 'composed', source: 'composed', line: first.line };
  const retry = await attempt('short');
  if (retry) return { status: 'composed', source: 'retry', line: retry.line };
  return { status: 'skipped', reason: 'model_failed' };
}
