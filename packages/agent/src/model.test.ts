import { describe, expect, it } from 'vitest';
import {
  type AgentTask,
  HAIKU_MODEL,
  OPUS_MODEL,
  SONNET5_MODEL,
  SONNET_MODEL,
  AGENT_TASKS,
  isAgentTask,
  laneRequestFields,
  pickLane,
  pickModel,
} from './model.js';

describe('pickModel', () => {
  it.each<[AgentTask, string]>([
    ['classify', SONNET5_MODEL],
    ['simple-lookup', HAIKU_MODEL],
    ['converse', SONNET5_MODEL],
    ['draft', SONNET5_MODEL],
    ['review', SONNET5_MODEL],
    ['infer', SONNET5_MODEL],
    ['discover', SONNET5_MODEL],
    ['high-stakes-judgment', OPUS_MODEL],
    ['triage', HAIKU_MODEL],
    ['extract', SONNET5_MODEL],
    ['acknowledge', HAIKU_MODEL],
    ['screen', HAIKU_MODEL],
    ['answer', HAIKU_MODEL],
    ['speak', HAIKU_MODEL],
  ])('maps %s → %s', (task, expected) => {
    expect(pickModel(task)).toBe(expected);
  });

  it('pins the model ids', () => {
    expect(HAIKU_MODEL).toBe('claude-haiku-4-5');
    expect(SONNET5_MODEL).toBe('claude-sonnet-5');
    expect(OPUS_MODEL).toBe('claude-opus-5');
  });

  it('keeps the judge tier off the lane matrix', () => {
    // SONNET_MODEL is the frozen judge / comparison rung. It is deliberately NOT
    // the model of any lane — if a re-tier ever routes traffic back to it, the
    // eval judge and its subject become the same model and grading stops meaning
    // anything.
    expect(SONNET_MODEL).toBe('claude-sonnet-4-6');
    expect(AGENT_TASKS.map(pickModel)).not.toContain(SONNET_MODEL);
  });

  it('throws on an unknown task', () => {
    expect(() => pickModel('nope' as AgentTask)).toThrow(/unknown task/);
  });
});

describe('laneRequestFields', () => {
  const HAIKU_TASKS: AgentTask[] = [
    'simple-lookup',
    'triage',
    'acknowledge',
    'screen',
    'answer',
    'speak',
  ];

  it.each(HAIKU_TASKS)('sends %s with no reasoning knobs at all', (task) => {
    // Verified against the live API 2026-08-21: Haiku 4.5 rejects BOTH knobs with
    // a 400 ("This model does not support the effort parameter" / "adaptive
    // thinking is not supported on this model"). `speak` is a live phone call, so
    // a 400 here is dead air on the line — the absence is the whole point.
    const fields = laneRequestFields(pickLane(task));
    expect(fields).toEqual({ model: HAIKU_MODEL });
  });

  it('sends the reasoning lanes with an explicit thinking mode and effort', () => {
    // The positive control for the assertion above: the same function DOES emit
    // both keys when the lane has them, so the Haiku cases are proving absence
    // rather than proving the function never sets anything.
    expect(laneRequestFields(pickLane('converse'))).toEqual({
      model: SONNET5_MODEL,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'low' },
    });
    expect(laneRequestFields(pickLane('high-stakes-judgment'))).toEqual({
      model: OPUS_MODEL,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'xhigh' },
    });
  });

  it('pins the per-lane effort the re-tier chose', () => {
    const effortOf = (task: AgentTask) => laneRequestFields(pickLane(task)).output_config?.effort;
    // The inline chat lane a parent waits on, versus the run-rarely one.
    expect(effortOf('converse')).toBe('low');
    expect(effortOf('draft')).toBe('medium');
    expect(effortOf('infer')).toBe('medium');
    expect(effortOf('discover')).toBe('medium');
    expect(effortOf('high-stakes-judgment')).toBe('xhigh');
    // The rule-#1 teen_content lanes keep the API defaults, written out.
    expect(effortOf('classify')).toBe('high');
    expect(effortOf('extract')).toBe('high');
    expect(effortOf('review')).toBe('high');
  });

  it('never disables thinking above high effort', () => {
    // `thinking: disabled` + `effort: xhigh` is a 400 on Opus 5 (verified live).
    // The LaneConfig union makes it unrepresentable; this asserts the table has
    // not been widened past the type in some future edit.
    for (const task of AGENT_TASKS) {
      const lane = pickLane(task);
      if ('thinking' in lane && lane.thinking === 'disabled') {
        expect(lane.effort).not.toBe('xhigh');
      }
    }
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
