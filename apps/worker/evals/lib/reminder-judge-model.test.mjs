import { describe, expect, it } from 'vitest';
import { HAIKU_MODEL, SONNET_MODEL } from '../../../../packages/agent/src/model.ts';
import { reminderJudgeModel } from './reminder-judge-model.mjs';

describe('reminderJudgeModel', () => {
  const agent = { SONNET_MODEL, HAIKU_MODEL };
  it('defaults to the shared Sonnet judge model, not Haiku', () => {
    expect(reminderJudgeModel({}, agent)).toBe(SONNET_MODEL);
    expect(reminderJudgeModel({}, agent)).not.toBe(HAIKU_MODEL);
  });
  it('honours REMINDER_JUDGE_MODEL for a comparison run', () => {
    expect(reminderJudgeModel({ REMINDER_JUDGE_MODEL: 'x' }, agent)).toBe('x');
  });
});
