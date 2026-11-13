import { pickLane } from '@hale/agent';
import { z } from 'zod';
import { loadCronSkill } from '~/lib/cron/skill';
import { voiceClient } from '~/lib/loop/voice/compose';
import { HOT_SMS_CLIENT_OPTIONS, budgetedAnthropic } from '~/lib/pipeline/client';
import { forceToolJson } from '~/lib/pipeline/structured';
import { groupLineLeaksPrivate } from './privacy';

export const GROUP_EXPERIENCE_VOICE_SKILL = 'group-experience-voice';
export const GROUP_EXPERIENCE_VOICE_MAX_TOKENS = 400;

export type GroupExperienceVoiceKind =
  | 'hello'
  | 'rsvp_open'
  | 'rsvp_tally'
  | 'time_open'
  | 'time_lock'
  | 'time_tie'
  | 'link_facts'
  | 'registration_1to1'
  | 'private_hold'
  | 'private_1to1'
  | 'mail_notice'
  | 'calendar_placed';

export type GroupExperienceVoiceSkip =
  | 'voice_unavailable'
  | 'skill_unavailable'
  | 'model_failed'
  | 'unusable'
  | 'private_leak';

export interface GroupExperienceLineInput {
  skill: typeof GROUP_EXPERIENCE_VOICE_SKILL;
  kind: GroupExperienceVoiceKind;
  language: 'en' | 'fr';
  audience: 'group' | 'one_to_one';
  questions: 0 | 1;
  facts: Record<string, unknown>;
}

export interface GroupExperienceSpoken {
  line: string;
  options: string[];
}

export interface GroupExperienceComposer {
  compose(
    input: GroupExperienceLineInput,
    options?: { prompt?: 'full' | 'short' },
  ): Promise<GroupExperienceSpoken>;
}

export const GROUP_EXPERIENCE_VOICE_TOOL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    send: { type: 'boolean' },
    line: { type: 'string' },
    options: { type: 'array', items: { type: 'string' } },
    why: { type: 'string' },
  },
  required: ['send'],
} as const;

const voiceAnswerSchema = z.object({
  send: z.boolean(),
  line: z.string().optional(),
  options: z.array(z.string()).optional(),
  why: z.string().optional(),
});

function optionLabels(raw: readonly string[] | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of raw ?? []) {
    const text = value.trim();
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

export function lineUsable(
  spoken: GroupExperienceSpoken,
  input: GroupExperienceLineInput,
  deny: readonly string[],
): boolean {
  const line = spoken.line.trim();
  if (!line) return false;
  if (input.questions === 1 && !line.includes('?')) return false;
  if (input.questions === 0 && line.includes('?')) return false;
  if (input.audience === 'group' && groupLineLeaksPrivate(line, deny)) return false;
  if (input.kind === 'rsvp_open' && spoken.options.length !== 3) return false;
  if (input.kind === 'time_open' && spoken.options.length < 2) return false;
  return true;
}

export function productionGroupExperienceComposer(): GroupExperienceComposer | undefined {
  if (!process.env.ANTHROPIC_API_KEY || process.env.VOICE_DISABLED === 'true') return undefined;
  return {
    async compose(input, options) {
      const skill = await loadCronSkill(GROUP_EXPERIENCE_VOICE_SKILL);
      const client = voiceClient() ?? budgetedAnthropic(HOT_SMS_CLIENT_OPTIONS, { stage: 'group' });
      const result = await forceToolJson({
        client,
        lane: pickLane(skill.meta.task),
        system: skill.instructions,
        userMessage: JSON.stringify({ ...input, retry: options?.prompt === 'short' }),
        toolName: 'send_group_experience_line',
        toolDescription: 'The one message Hale sends, or a decision to stay quiet.',
        inputJsonSchema: GROUP_EXPERIENCE_VOICE_TOOL_SCHEMA,
        schema: voiceAnswerSchema,
        maxTokens: options?.prompt === 'short' ? 160 : GROUP_EXPERIENCE_VOICE_MAX_TOKENS,
      });
      if (!result.value.send) throw new Error('group experience voice: send false');
      return {
        line: result.value.line?.trim() ?? '',
        options: optionLabels(result.value.options),
      };
    },
  };
}

export async function composeGroupExperienceLine(
  input: GroupExperienceLineInput,
  composer: GroupExperienceComposer | undefined,
  deny: readonly string[] = [],
): Promise<
  | { status: 'composed'; line: string; options: string[] }
  | { status: 'skipped'; reason: GroupExperienceVoiceSkip }
> {
  if (!composer) return { status: 'skipped', reason: 'voice_unavailable' };
  const attempt = async (
    prompt: 'full' | 'short',
  ): Promise<GroupExperienceSpoken | null | 'private'> => {
    try {
      const spoken = await composer.compose(input, { prompt });
      if (input.audience === 'group' && groupLineLeaksPrivate(spoken.line, deny)) {
        return 'private';
      }
      return lineUsable(spoken, input, deny) ? spoken : null;
    } catch (err) {
      console.warn(
        { prompt, err: err instanceof Error ? err.name : 'unknown' },
        'group experience: voice failed',
      );
      return null;
    }
  };
  const full = await attempt('full');
  if (full === 'private') return { status: 'skipped', reason: 'private_leak' };
  if (full) return { status: 'composed', line: full.line.trim(), options: full.options };
  const short = await attempt('short');
  if (short === 'private') return { status: 'skipped', reason: 'private_leak' };
  if (short) return { status: 'composed', line: short.line.trim(), options: short.options };
  return { status: 'skipped', reason: 'unusable' };
}
