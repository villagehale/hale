import { describe, expect, it } from 'vitest';
import { withoutMessageCacheMarkers } from './harness.mjs';

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
});
