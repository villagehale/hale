import { pickLane } from '@hale/agent';
import { isEnabled } from '@hale/flags';
import { z } from 'zod';
import { loadCronSkill } from '~/lib/cron/skill';
import { hasLinkShape } from '~/lib/format/link-shape';
import { type EventDate, textDestination } from '~/lib/loop/voice/calendar-destination';
import { voiceClient } from '~/lib/loop/voice/compose';
import { HOT_SMS_CLIENT_OPTIONS, budgetedAnthropic } from '~/lib/pipeline/client';
import { forceToolJson } from '~/lib/pipeline/structured';
import { GROUP_PLAN_RSVP_CALENDAR_VOICE_SKILL, type GroupPlanCalendarLineInput } from './calendar';
import type { GroupPlanRsvpLineInput, GroupPlanWhichLineInput } from './facts';
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

export type GroupLineInput =
  | GroupPlanRsvpLineInput
  | GroupPlanWhichLineInput
  | GroupPollLineInput
  | GroupPlanCalendarLineInput;

export interface GroupPlanRsvpComposer {
  compose(
    input: GroupLineInput,
    options?: { prompt?: 'full' | 'short' },
  ): Promise<{ line: string }>;
}

export const GROUP_PLAN_RSVP_VOICE_MAX_TOKENS = 400;

export const GROUP_PLAN_VOICE_TOOL_NAME = 'send_group_line';
export const GROUP_PLAN_VOICE_TOOL_DESCRIPTION = 'The one message Hale sends.';

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

/**
 * A private calendar line is handed its start as a spoken label ("Sun, Nov 1 at
 * 11:00 AM"), never a numeric date, so no date excuses a run of digits in it.
 */
const NO_HANDED_DATE: EventDate = { year: 0, month: 0, day: 0 };

function lineUsable(line: string, input: GroupLineInput): boolean {
  if (!line.trim()) return false;
  if (hasLinkShape(line)) return false;
  // A 1:1 line goes to one parent's own phone: no number to dial or address to mail,
  // whatever the plan title or their own words held.
  if (
    input.skill === GROUP_PLAN_RSVP_CALENDAR_VOICE_SKILL &&
    textDestination(line, NO_HANDED_DATE) !== null
  ) {
    return false;
  }
  if (input.questions === 1 && !line.includes('?')) return false;
  if (input.questions === 0 && line.includes('?')) return false;
  return true;
}

export function productionGroupPlanRsvpComposer(): GroupPlanRsvpComposer | undefined {
  if (!process.env.ANTHROPIC_API_KEY || !isEnabled('voice')) return undefined;
  return {
    async compose(input, options) {
      const skill = await loadCronSkill(input.skill);
      const client =
        voiceClient() ?? budgetedAnthropic(HOT_SMS_CLIENT_OPTIONS, { stage: 'group' });
      const result = await forceToolJson({
        client,
        lane: pickLane(skill.meta.task),
        system: skill.instructions,
        userMessage: JSON.stringify({ ...input, retry: options?.prompt === 'short' }),
        toolName: GROUP_PLAN_VOICE_TOOL_NAME,
        toolDescription: GROUP_PLAN_VOICE_TOOL_DESCRIPTION,
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
