import { afterEach, describe, expect, it } from 'vitest';
import { evalSubjectRequest } from './harness.mjs';

const previousModel = process.env.EVAL_GATEWAY_MODEL;

afterEach(() => {
  if (previousModel === undefined) Reflect.deleteProperty(process.env, 'EVAL_GATEWAY_MODEL');
  else process.env.EVAL_GATEWAY_MODEL = previousModel;
});

describe('evalSubjectRequest', () => {
  it('changes only an explicitly enabled subject to Gateway-safe request fields', () => {
    const baseline = {
      model: 'claude-sonnet-5',
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium' },
      messages: [{ role: 'user', content: 'fixture' }],
    };

    Reflect.deleteProperty(process.env, 'EVAL_GATEWAY_MODEL');
    expect(evalSubjectRequest(baseline)).toBe(baseline);

    process.env.EVAL_GATEWAY_MODEL = 'deepseek/deepseek-v4.1-flash';
    expect(evalSubjectRequest(baseline)).toEqual({
      model: 'deepseek/deepseek-v4.1-flash',
      thinking: { type: 'disabled' },
      messages: baseline.messages,
    });
  });
});
