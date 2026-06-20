import { describe, expect, it } from 'vitest';
import {
  type AgentTask,
  HAIKU_MODEL,
  OPUS_MODEL,
  SONNET_MODEL,
  isAgentTask,
  pickModel,
} from './model.js';

describe('pickModel', () => {
  it.each<[AgentTask, string]>([
    ['classify', HAIKU_MODEL],
    ['simple-lookup', HAIKU_MODEL],
    ['converse', SONNET_MODEL],
    ['draft', SONNET_MODEL],
    ['review', SONNET_MODEL],
    ['infer', SONNET_MODEL],
    ['discover', SONNET_MODEL],
    ['high-stakes-judgment', OPUS_MODEL],
  ])('maps %s → %s', (task, expected) => {
    expect(pickModel(task)).toBe(expected);
  });

  it('pins the three model ids', () => {
    expect(HAIKU_MODEL).toBe('claude-haiku-4-5');
    expect(SONNET_MODEL).toBe('claude-sonnet-4-6');
    expect(OPUS_MODEL).toBe('claude-opus-4-8');
  });

  it('throws on an unknown task', () => {
    expect(() => pickModel('nope' as AgentTask)).toThrow(/unknown task/);
  });
});

describe('isAgentTask', () => {
  it('accepts known tasks and rejects typos', () => {
    expect(isAgentTask('converse')).toBe(true);
    expect(isAgentTask('high-stakes-judgment')).toBe(true);
    expect(isAgentTask('Converse')).toBe(false);
    expect(isAgentTask('judge')).toBe(false);
  });
});
