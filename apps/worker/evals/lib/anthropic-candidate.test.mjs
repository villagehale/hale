import { describe, expect, it } from 'vitest';
import { evalAnthropicRequest } from './harness.mjs';

describe('evalAnthropicRequest', () => {
  it('leaves current production model requests unchanged', () => {
    const request = {
      model: 'claude-sonnet-5',
      thinking: { type: 'disabled' },
      tool_choice: { type: 'tool', name: 'result' },
    };

    expect(evalAnthropicRequest(request)).toBe(request);
  });

  it('uses Sonnet 5.5 compatible thinking and tool choice', () => {
    expect(
      evalAnthropicRequest({
        model: 'claude-sonnet-5-5',
        thinking: { type: 'disabled' },
        output_config: { effort: 'high' },
        tool_choice: { type: 'tool', name: 'result' },
      }),
    ).toEqual({
      model: 'claude-sonnet-5-5',
      thinking: { type: 'between_tools' },
      output_config: { effort: 'high' },
      tool_choice: { type: 'auto' },
    });
  });

  it('keeps adaptive thinking while removing forced tool choice for Opus 5.5', () => {
    expect(
      evalAnthropicRequest({
        model: 'claude-opus-5-5',
        thinking: { type: 'adaptive' },
        output_config: { effort: 'xhigh' },
        tool_choice: { type: 'any' },
      }),
    ).toEqual({
      model: 'claude-opus-5-5',
      thinking: { type: 'adaptive' },
      output_config: { effort: 'xhigh' },
      tool_choice: { type: 'auto' },
    });
  });

  it('rejects the unsupported Opus 5.5 disabled-thinking shape', () => {
    expect(() =>
      evalAnthropicRequest({
        model: 'claude-opus-5-5',
        thinking: { type: 'disabled' },
      }),
    ).toThrow(/requires adaptive thinking/);
  });
});
