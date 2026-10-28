import type { AgentClient } from '@hale/agent';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createGroupPlanReader,
  groupPlanUserMessage,
  stanceFromReading,
} from './group-plan-reader';

vi.mock('~/lib/pipeline/structured', () => ({ forceToolJson: vi.fn() }));
vi.mock('~/lib/cron/skill', () => ({
  loadCronSkill: async () => ({
    meta: { name: 'group-plan-read', whenToUse: 'x', task: 'screen', tools: [] },
    instructions: 'read',
  }),
}));

const { forceToolJson } = await import('~/lib/pipeline/structured');
const CLIENT = {} as AgentClient;
const INPUT = {
  text: 'hale can you find us a saturday swim',
  reactionType: null,
  senderName: 'Priya',
  options: [],
  answered: [],
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.mocked(forceToolJson).mockReset();
});

describe('VIL-441 group plan reader', () => {
  it('returns the model reading, with no echo of the text required', async () => {
    vi.mocked(forceToolJson).mockResolvedValue({
      value: { intent: 'plan_ask', optionId: null, subject: 'saturday swim', confidence: 'high' },
    } as never);
    expect(await createGroupPlanReader(CLIENT).read(INPUT)).toEqual({
      intent: 'plan_ask',
      optionId: null,
      subject: 'saturday swim',
      confidence: 'high',
    });
  });

  it('survives a thrown model call and changes no state', async () => {
    vi.mocked(forceToolJson).mockRejectedValue(new Error('boom'));
    expect(await createGroupPlanReader(CLIENT).read(INPUT)).toBeNull();
  });

  it('hands the model the text, tapback, options and who has answered', () => {
    const payload = JSON.parse(
      groupPlanUserMessage({
        text: 'count us in',
        reactionType: 'like',
        senderName: 'Jordan',
        options: [{ id: '1', name: 'Elm swim', when: 'Sat 9:15', where: 'Elm rec' }],
        answered: [{ name: 'Priya', stance: 'yes' }],
      }),
    );
    expect(payload.text).toBe('count us in');
    expect(payload.reactionType).toBe('like');
    expect(payload.options[0].name).toBe('Elm swim');
    expect(payload.answered).toEqual([{ name: 'Priya', stance: 'yes' }]);
  });

  it('stores only a high-confidence yes/no/maybe', () => {
    expect(
      stanceFromReading({
        intent: 'yes',
        optionId: '1',
        subject: null,
        confidence: 'high',
      }),
    ).toEqual({ stance: 'yes', optionId: '1' });
    expect(
      stanceFromReading({
        intent: 'maybe',
        optionId: null,
        subject: null,
        confidence: 'low',
      }),
    ).toBeNull();
    expect(
      stanceFromReading({
        intent: 'chatter',
        optionId: null,
        subject: null,
        confidence: 'high',
      }),
    ).toBeNull();
    expect(stanceFromReading(null)).toBeNull();
  });
});
