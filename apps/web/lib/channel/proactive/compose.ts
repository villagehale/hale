import { type AgentClient, pickLane } from '@hale/agent';
import { z } from 'zod';
import { loadCronSkill } from '~/lib/cron/skill';
import { forceToolJson } from '~/lib/pipeline/structured';
import {
  type ToolCandidate,
  WRITER_MAX_TOKENS,
  WRITER_TOOL,
  WRITER_TOOL_SCHEMA,
  type WriterResult,
  readWriterText,
  withActivityLinks,
  writerContext,
} from './tools';

/**
 * VIL-226 · one writer for a batch the decider already chose. There is no template
 * behind it: a missing client, a failed call, or a text carrying a link or a time it was
 * not given is a named skip and nothing is sent. A link the model left out for an
 * activity it named is appended after the grounding check.
 */

export const WRITER_SKILL = 'proactive-writer';

export { WRITER_TOOL_SCHEMA, type WriterResult, readWriterText, withActivityLinks };

export async function composeProactiveBatch(input: {
  items: readonly ToolCandidate[];
  client: AgentClient | null;
  /** The family's stored language tag, handed to the writer as-is. */
  language?: string | null;
}): Promise<WriterResult> {
  if (!input.client) return { skipped: 'no_client' };
  const skill = await loadCronSkill(WRITER_SKILL);
  let value: unknown;
  try {
    const result = await forceToolJson({
      client: input.client,
      lane: pickLane(skill.meta.task),
      system: skill.instructions,
      // No cadence note: a parent's words about pace are not stored (preference.ts).
      userMessage: writerContext(input.items, null, input.language ?? null),
      toolName: WRITER_TOOL,
      toolDescription: 'The one text Hale sends.',
      inputJsonSchema: WRITER_TOOL_SCHEMA,
      schema: z.unknown(),
      maxTokens: WRITER_MAX_TOKENS,
    });
    value = result.value;
  } catch (err) {
    // Never the message: a provider 400 can quote the request, parent words and all.
    console.error(
      { err: err instanceof Error ? err.constructor.name : 'unknown' },
      'proactive writer: model call failed',
    );
    return { skipped: 'model_failed' };
  }
  return readWriterText(value, input.items);
}
