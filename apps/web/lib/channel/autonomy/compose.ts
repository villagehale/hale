import { type AgentClient, pickLane } from '@hale/agent';
import { z } from 'zod';
import { loadCronSkill } from '~/lib/cron/skill';
import { voiceClient } from '~/lib/loop/voice/compose';
import { forceToolJson } from '~/lib/pipeline/structured';
import {
  AUTONOMY_NOTICE_MAX_TOKENS,
  AUTONOMY_NOTICE_TOOL,
  AUTONOMY_NOTICE_TOOL_SCHEMA,
  type AutonomyNoticeContext,
  type AutonomyNoticeText,
  autonomyNoticeContext,
  readAutonomyNotice,
} from './notice-text';

/**
 * The model writes the turn-on, re-arm, and on-its-own texts. There is no sentence
 * behind it: a missing client, a failed call, or a text that fails the structural
 * check is a named skip and nothing is sent.
 */

export const AUTONOMY_NOTICE_SKILL = 'autonomy-notice';

export async function composeAutonomyNotice(
  input: AutonomyNoticeContext,
  client: AgentClient | null = voiceClient(),
): Promise<AutonomyNoticeText> {
  if (!client) return { skipped: 'no_client' };
  const skill = await loadCronSkill(AUTONOMY_NOTICE_SKILL);
  let value: unknown;
  try {
    const result = await forceToolJson({
      client,
      lane: pickLane(skill.meta.task),
      system: skill.instructions,
      userMessage: autonomyNoticeContext(input),
      toolName: AUTONOMY_NOTICE_TOOL,
      toolDescription: 'The one text Hale sends.',
      inputJsonSchema: AUTONOMY_NOTICE_TOOL_SCHEMA,
      schema: z.unknown(),
      maxTokens: AUTONOMY_NOTICE_MAX_TOKENS,
    });
    value = result.value;
  } catch (err) {
    console.error(
      { err: err instanceof Error ? err.constructor.name : 'unknown' },
      'autonomy notice: model call failed',
    );
    return { skipped: 'model_failed' };
  }
  return readAutonomyNotice(value, input);
}
