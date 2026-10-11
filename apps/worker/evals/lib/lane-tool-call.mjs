// A cached forced-tool call that carries the skill's LANE faithfully: the model, the
// thinking mode and the effort the runtime's forceToolJson sends (apps/web/lib/pipeline/
// structured.ts), all in the request AND the cache key, so a replay grades the model
// production runs. Truncation is never cached as an answer.

import { cacheGet, cacheKey, cachePut, noteUsage } from './harness.mjs';

export async function cachedLaneToolCall({
  agent,
  lane,
  tag,
  system,
  userMessage,
  toolName,
  toolDescription,
  toolSchema,
  maxTokens,
  cachedOnly,
  getClient,
  cost,
}) {
  const fields = agent.laneRequestFields(lane);
  const toolChoice =
    lane.model === agent.SONNET55_MODEL ? { type: 'auto' } : { type: 'tool', name: toolName };
  const canonical = JSON.stringify({
    fields,
    system,
    userMessage,
    toolName,
    toolSchema,
    toolChoice,
    maxTokens,
  });
  const key = cacheKey(tag, canonical);
  const cached = await cacheGet(key);
  if (cached) return { value: cached.value, key, cached: true };
  if (cachedOnly) return { value: null, key, cached: false, miss: true };

  const response = await getClient().messages.create({
    ...fields,
    max_tokens: maxTokens,
    system,
    tools: [{ name: toolName, description: toolDescription, input_schema: toolSchema }],
    tool_choice: toolChoice,
    messages: [{ role: 'user', content: userMessage }],
  });
  if (response.stop_reason === 'max_tokens') {
    throw new Error(`${tag}: tool call truncated at max_tokens (${maxTokens}) - nothing cached`);
  }
  const toolUse = response.content.find(
    (block) => block.type === 'tool_use' && block.name === toolName,
  );
  if (!toolUse) throw new Error(`${tag}: model returned no ${toolName} tool call`);
  noteUsage(cost, fields.model, response.usage);
  await cachePut(key, { value: toolUse.input, stopReason: response.stop_reason });
  return { value: toolUse.input, key, cached: false };
}
