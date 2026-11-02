import { describe, expect, it } from 'vitest';
import { agentCacheMaterial, cacheKey, withoutMessageCacheMarkers } from './harness.mjs';

describe('withoutMessageCacheMarkers (VIL-430)', () => {
  it('hashes a marked request the same as the unmarked one', () => {
    const plain = [
      { role: 'user', content: 'ctx' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'x', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] },
    ];
    const marked = structuredClone(plain);
    marked[2].content[0].cache_control = { type: 'ephemeral' };
    expect(JSON.stringify(withoutMessageCacheMarkers(marked))).toBe(JSON.stringify(plain));
    expect(withoutMessageCacheMarkers(plain)[2]).toBe(plain[2]);
  });

  it('a prompt change moves the agent key even when the system block has no text', () => {
    const request = {
      model: 'claude-sonnet-5-5',
      system: [{ type: 'text', cache_control: { type: 'ephemeral' } }],
      tools: [],
      messages: [{ role: 'user', content: 'got the diapers and wipes' }],
      max_tokens: 400,
      thinking: { type: 'adaptive' },
    };
    const before = cacheKey('group-lists:en-got-it:agent', agentCacheMaterial(request, 'old tone'));
    const after = cacheKey('group-lists:en-got-it:agent', agentCacheMaterial(request, 'new tone'));
    expect(after).not.toBe(before);
  });
});
