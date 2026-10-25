import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { withHistoryBreakpoint } from './agent.js';

const first: Anthropic.MessageParam = { role: 'user', content: '{"family":"ctx"}' };
const assistant: Anthropic.MessageParam = {
  role: 'assistant',
  content: [{ type: 'tool_use', id: 't1', name: 'look', input: {} }],
};
const results = (n: number): Anthropic.MessageParam => ({
  role: 'user',
  content: Array.from({ length: n }, (_, i) => ({
    type: 'tool_result' as const,
    tool_use_id: `t${i + 1}`,
    content: 'ok',
  })),
});

describe('withHistoryBreakpoint (VIL-430)', () => {
  it('leaves a one-message (step 1) request untouched', () => {
    const messages = [first];
    expect(withHistoryBreakpoint(messages)).toBe(messages);
  });

  it('marks only the last tool-result block, on a copy', () => {
    const messages = [first, assistant, results(2)];
    const before = JSON.stringify(messages);
    const sent = withHistoryBreakpoint(messages);
    expect(JSON.stringify(messages)).toBe(before);
    const blocks = sent[2]?.content as unknown as Array<Record<string, unknown>>;
    expect(blocks[0]?.cache_control).toBeUndefined();
    expect(blocks[1]?.cache_control).toEqual({ type: 'ephemeral' });
    expect(sent[0]).toBe(first);
  });

  it('keeps one marker as the loop grows (never accumulates)', () => {
    const messages = [first, assistant, results(1), assistant, results(1)];
    const marks = JSON.stringify(withHistoryBreakpoint(messages)).match(/cache_control/g) ?? [];
    expect(marks).toHaveLength(1);
  });

  it('does not mark a trailing assistant or text turn', () => {
    const text: Anthropic.MessageParam = { role: 'user', content: [{ type: 'text', text: 'hi' }] };
    expect(withHistoryBreakpoint([first, assistant])).toEqual([first, assistant]);
    expect(withHistoryBreakpoint([first, assistant, text])[2]).toBe(text);
  });
});
