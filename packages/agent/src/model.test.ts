import { describe, expect, it } from 'vitest';
import {
  AGENT_TASKS,
  type AgentTask,
  DEEPSEEK_MODEL,
  HAIKU_MODEL,
  JUDGE_MODEL,
  type LaneConfig,
  OPUS_MODEL,
  SONNET_MODEL,
  isAgentTask,
  laneRequestFields,
  pickLane,
  pickModel,
  structuredToolChoice,
  withoutThinking,
} from './model.js';

describe('pickModel', () => {
  it.each<[AgentTask, string]>([
    ['classify', 'claude-sonnet-5-5'],
    ['simple-lookup', 'claude-haiku-5-5'],
    ['converse', 'claude-sonnet-5-5'],
    ['draft', 'claude-sonnet-5-5'],
    ['review', 'claude-sonnet-5-5'],
    ['infer', 'claude-sonnet-5-5'],
    ['discover', 'claude-sonnet-5-5'],
    ['high-stakes-judgment', 'claude-opus-5-5'],
    ['plan', 'claude-opus-5-5'],
    ['triage', 'claude-haiku-5-5'],
    ['extract', 'claude-sonnet-5-5'],
    ['acknowledge', 'claude-haiku-5-5'],
    ['screen', 'claude-haiku-5-5'],
    ['answer', 'claude-haiku-5-5'],
    ['speak', 'claude-haiku-5-5'],
  ])('maps %s → %s', (task, expected) => {
    expect(pickModel(task)).toBe(expected);
  });

  it('pins the model ids, the eval judge included', () => {
    expect(HAIKU_MODEL).toBe('claude-haiku-5-5');
    expect(SONNET_MODEL).toBe('claude-sonnet-5-5');
    expect(OPUS_MODEL).toBe('claude-opus-5-5');
    expect(JUDGE_MODEL).toBe('claude-opus-5-5');
    expect(DEEPSEEK_MODEL).toBe('deepseek/deepseek-v4.1-flash');
  });

  it('runs every lane on the 5.5 generation', () => {
    expect(AGENT_TASKS.filter((t) => !pickModel(t).endsWith('-5-5'))).toEqual([]);
  });

  it('throws on an unknown task', () => {
    expect(() => pickModel('nope' as AgentTask)).toThrow(/unknown task/);
  });
});

describe('laneRequestFields', () => {
  it('disables Gateway reasoning, requires ZDR, and omits Claude effort', () => {
    expect(laneRequestFields({ model: DEEPSEEK_MODEL, thinking: 'disabled' })).toEqual({
      model: DEEPSEEK_MODEL,
      thinking: { type: 'disabled' },
      providerOptions: { gateway: { zeroDataRetention: true } },
    });
  });

  it.each<[AgentTask, string]>([
    ['simple-lookup', 'low'],
    ['triage', 'low'],
    ['screen', 'medium'],
    ['acknowledge', 'medium'],
    ['answer', 'medium'],
  ])('sends the %s Haiku lane adaptive at %s effort', (task, effort) => {
    // Effort is Haiku 5.5's lever, not `disabled`: thinking off failed the acknowledge
    // and answer lanes' evals that adaptive passes (2026-10-11 re-record).
    expect(laneRequestFields(pickLane(task))).toEqual({
      model: 'claude-haiku-5-5',
      thinking: { type: 'adaptive' },
      output_config: { effort },
    });
  });

  it('keeps thinking off on the phone-call lane, where time to first token is the call', () => {
    expect(laneRequestFields(pickLane('speak'))).toEqual({
      model: 'claude-haiku-5-5',
      thinking: { type: 'disabled' },
      output_config: { effort: 'medium' },
    });
  });

  it('sends draft and infer thinking-off in the only shape Sonnet 5.5 accepts', () => {
    for (const task of ['draft', 'infer'] as AgentTask[]) {
      expect(laneRequestFields(pickLane(task))).toEqual({
        model: 'claude-sonnet-5-5',
        thinking: { type: 'between_tools' },
        output_config: { effort: 'high' },
      });
    }
  });

  it('pins the per-lane effort of the reasoning lanes', () => {
    const effortOf = (task: AgentTask) => laneRequestFields(pickLane(task)).output_config?.effort;
    expect(effortOf('converse')).toBe('high');
    expect(effortOf('discover')).toBe('medium');
    expect(effortOf('high-stakes-judgment')).toBe('xhigh');
    // The plan a parent is waiting on: Opus at `high` (Barton, 2026-10-11).
    expect(effortOf('plan')).toBe('high');
    expect(effortOf('classify')).toBe('high');
    expect(effortOf('extract')).toBe('high');
    expect(effortOf('review')).toBe('high');
  });

  it('never sends a thinking shape the lane model rejects', () => {
    // `disabled` is a 400 on Sonnet 5.5 and Opus 5.5, `between_tools` on everything but
    // Sonnet 5.5, and either thinking-off shape is a 400 above `high`.
    for (const task of AGENT_TASKS) {
      const { model, thinking, output_config } = laneRequestFields(pickLane(task));
      if (thinking?.type === 'disabled') expect(model).toBe(HAIKU_MODEL);
      if (thinking?.type === 'between_tools') expect(model).toBe(SONNET_MODEL);
      if (thinking?.type !== 'adaptive') expect(output_config?.effort).not.toBe('xhigh');
    }
  });

  it('makes Opus with thinking disabled a type error', () => {
    // @ts-expect-error — Opus 5.5 cannot disable thinking at any effort.
    const lane: LaneConfig = { model: OPUS_MODEL, thinking: 'disabled', effort: 'low' };
    expect(lane.model).toBe(OPUS_MODEL);
  });
});

describe('structuredToolChoice', () => {
  it('forces the tool only where the model accepts it', () => {
    expect(structuredToolChoice(HAIKU_MODEL, 'x')).toEqual({ type: 'tool', name: 'x' });
    expect(structuredToolChoice(SONNET_MODEL, 'x')).toEqual({
      type: 'auto',
      disable_parallel_tool_use: true,
    });
    expect(structuredToolChoice(OPUS_MODEL, 'x')).toEqual({
      type: 'auto',
      disable_parallel_tool_use: true,
    });
  });
});

describe('withoutThinking', () => {
  it('turns Sonnet 5.5 thinking off with between_tools, keeping the effort', () => {
    expect(withoutThinking(pickLane('converse'))).toEqual({
      model: SONNET_MODEL,
      thinking: 'between_tools',
      effort: 'high',
    });
    expect(withoutThinking(pickLane('discover'))).toEqual({
      model: SONNET_MODEL,
      thinking: 'between_tools',
      effort: 'medium',
    });
  });

  it('turns Haiku 5.5 thinking off with disabled, clamping xhigh to high', () => {
    expect(withoutThinking({ model: HAIKU_MODEL, thinking: 'adaptive', effort: 'xhigh' })).toEqual({
      model: HAIKU_MODEL,
      thinking: 'disabled',
      effort: 'high',
    });
  });

  it('drops Opus 5.5 to low effort, since it cannot turn thinking off', () => {
    expect(withoutThinking(pickLane('high-stakes-judgment'))).toEqual({
      model: OPUS_MODEL,
      thinking: 'adaptive',
      effort: 'low',
    });
    expect(withoutThinking({ model: OPUS_MODEL, thinking: 'adaptive', effort: 'low' })).toBeNull();
  });

  it('turns an adaptive Haiku lane off at the same effort', () => {
    expect(withoutThinking(pickLane('answer'))).toEqual({
      model: HAIKU_MODEL,
      thinking: 'disabled',
      effort: 'medium',
    });
  });

  it.each<AgentTask>(['draft', 'infer', 'speak'])('has no less-thinking form for %s', (task) => {
    expect(withoutThinking(pickLane(task))).toBeNull();
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
