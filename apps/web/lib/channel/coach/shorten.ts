import type Anthropic from '@anthropic-ai/sdk';
import { type AgentClient, laneRequestFields, pickLane, withoutThinking } from '@hale/agent';
import { loadCronSkill } from '~/lib/cron/skill';

/** Enough for two short sentences. Thinking is off, so the budget is text. */
const SHORTEN_MAX_TOKENS = 200;

/**
 * One rewrite of an answer that had no complete sentence inside the segment budget.
 *
 * The system prompt is `coach-channel-shorten` (rule #2). The user message is the
 * over-long text and the ceiling — data, not a second prompt. An empty rewrite is
 * null. Nothing in this module is a sentence a parent could be sent instead.
 */
export async function shortenOverBudgetReply(
  client: AgentClient,
  text: string,
  ceiling: number,
): Promise<string | null> {
  const skill = await loadCronSkill('coach-channel-shorten');
  const thinkingOff = withoutThinking(pickLane(skill.meta.task));
  if (thinkingOff === null) {
    throw new Error('channel coach: shorten lane has no thinking-off shape');
  }
  const response = await client.messages.create({
    ...(laneRequestFields(thinkingOff) as Pick<Anthropic.MessageCreateParams, 'model'>),
    max_tokens: SHORTEN_MAX_TOKENS,
    system: skill.instructions,
    messages: [{ role: 'user', content: JSON.stringify({ ceiling, text }) }],
  });
  const joined = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim();
  return joined === '' ? null : joined;
}
