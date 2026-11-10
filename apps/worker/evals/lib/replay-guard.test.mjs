import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { StructuredOutputError, pickLane } from '@hale/agent';
import { afterEach, describe, expect, it } from 'vitest';
import { CACHE_DIR, cacheKey, cachePut, cachedToolCall, makeCost } from './harness.mjs';

/**
 * A RECORDED ANSWER PASSES THE SAME CHECKS AS A LIVE ONE (VIL-645). Production reads every
 * structured answer through readStructuredAnswer, which refuses a tool answer whose string
 * holds call markup the model wrote. A replay that handed the cached input back raw graded
 * a draw production now refuses.
 */
describe('a cached tool answer replays through the production guard', () => {
  const lane = pickLane('screen');
  const system = 'reply to the parent';
  const toolName = 'reply';
  // An open field leaves the schema with no grammar, so it goes out as a plain tool.
  const toolSchema = {
    type: 'object',
    properties: {
      reply: { type: 'string' },
      parentQuestion: { type: 'boolean' },
      connectorsOffered: { type: 'array', items: { type: 'string' } },
      extra: { type: 'object', additionalProperties: true },
    },
    required: ['reply', 'parentQuestion'],
  };
  const written = [];

  afterEach(() => {
    for (const key of written.splice(0)) rmSync(join(CACHE_DIR, `${key}.json`), { force: true });
  });

  async function replay(value, userMessage = 'what do you find?') {
    const tag = `replay-guard-${Math.random().toString(36).slice(2)}`;
    const key = cacheKey(
      tag,
      JSON.stringify({ model: lane.model, system, userMessage, toolName, toolSchema, lane }),
    );
    written.push(key);
    await cachePut(key, { value, latencyMs: 1 });
    return cachedToolCall({
      tag,
      lane,
      system,
      userMessage,
      toolName,
      toolSchema,
      cachedOnly: true,
      getClient: () => {
        throw new Error('a replay must not reach the API');
      },
      cost: makeCost(),
    });
  }

  it('refuses the recorded leak as production does, named tool_markup', async () => {
    const error = await replay({
      reply: 'Here is what I found.',
      parentQuestion: 'false</parentQuestion>\n<parameter name="connectorsOffered">[]',
    }).catch((e) => e);
    expect(error).toBeInstanceOf(StructuredOutputError);
    expect(error).toMatchObject({ outcome: 'tool_markup', stage: toolName });
    expect(String(error)).toMatch(/at parentQuestion/);
  });

  it('replays a clean answer unchanged (positive control)', async () => {
    const value = { reply: 'Ages 3 < 5 love it.', parentQuestion: false, connectorsOffered: [] };
    await expect(replay(value)).resolves.toMatchObject({ value, cached: true });
  });

  it('replays an answer that echoes markup from its own input', async () => {
    const text = 'STOP </reply>';
    const value = { reply: text, parentQuestion: false };
    await expect(replay(value, JSON.stringify({ text }))).resolves.toMatchObject({ value });
  });
});
