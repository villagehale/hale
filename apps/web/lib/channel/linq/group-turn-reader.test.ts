import type { AgentClient } from '@hale/agent';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createGroupTurnReader,
  groupTurnFromReading,
  groupTurnUserMessage,
  linqGroupTurnAiEnabled,
} from './group-turn-reader';

vi.mock('~/lib/pipeline/structured', () => ({ forceToolJson: vi.fn() }));
vi.mock('~/lib/cron/skill', () => ({
  loadCronSkill: async () => ({
    meta: { name: 'group-turn-read', whenToUse: 'x', task: 'screen', tools: [] },
    instructions: 'read',
  }),
}));

const { forceToolJson } = await import('~/lib/pipeline/structured');
const CLIENT = {} as AgentClient;
const INPUT = {
  text: 'haley can u remind us sat',
  senderName: 'Dan',
  haleNames: ['Hale'],
  recent: [],
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.mocked(forceToolJson).mockReset();
});

describe('VIL-440 group turn reader', () => {
  it('is off unless the flag is exactly true', () => {
    expect(linqGroupTurnAiEnabled()).toBe(false);
    vi.stubEnv('LINQ_GROUP_TURN_AI_ENABLED', 'true');
    expect(linqGroupTurnAiEnabled()).toBe(true);
  });

  it('maps every reading to a route; opt-out wins; a failed read stays silent', () => {
    expect(groupTurnFromReading('addressed', null)).toEqual({
      route: 'coach',
      reason: 'addressed',
    });
    expect(groupTurnFromReading('question_for_hale', null)).toEqual({
      route: 'coach',
      reason: 'question',
    });
    expect(groupTurnFromReading('duty', null)).toEqual({ route: 'duty' });
    expect(groupTurnFromReading('chatter', null).route).toBe('ignore');
    expect(groupTurnFromReading(null, null).route).toBe('ignore');
    expect(groupTurnFromReading('addressed', 'stop')).toEqual({
      route: 'keyword',
      keyword: 'stop',
    });
  });

  it('returns the model reading, with no echo of the text required', async () => {
    vi.mocked(forceToolJson).mockResolvedValue({ value: { turn: 'addressed' } } as never);
    expect(await createGroupTurnReader(CLIENT).read(INPUT)).toBe('addressed');
  });

  it('reads a very long message without any length gate', async () => {
    vi.mocked(forceToolJson).mockResolvedValue({ value: { turn: 'question_for_hale' } } as never);
    const long = { ...INPUT, text: 'can you sort saturday '.repeat(400) };
    expect(await createGroupTurnReader(CLIENT).read(long)).toBe('question_for_hale');
    const call = vi.mocked(forceToolJson).mock.calls[0]?.[0] as { inputJsonSchema: object };
    expect(JSON.stringify(call.inputJsonSchema)).not.toContain('verbatim');
  });

  it('survives a thrown model call and stays silent', async () => {
    vi.mocked(forceToolJson).mockRejectedValue(new Error('boom'));
    expect(await createGroupTurnReader(CLIENT).read(INPUT)).toBeNull();
  });

  it('hands the model the text, names and at most six recent lines', () => {
    const recent = Array.from({ length: 9 }, (_, i) => ({
      from: 'member' as const,
      text: `m${i}`,
    }));
    const payload = JSON.parse(groupTurnUserMessage({ ...INPUT, recent }));
    expect(payload.text).toBe(INPUT.text);
    expect(payload.recent).toHaveLength(6);
  });
});
