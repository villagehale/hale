import type { AgentClient } from '@hale/agent';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type ConfirmFacts,
  createGroupReminderVoice,
  groupReminderRefusals,
  groupReminderVoiceUserMessage,
  whenFact,
} from './voice';

vi.mock('~/lib/pipeline/structured', () => ({ forceToolJson: vi.fn() }));
vi.mock('~/lib/cron/skill', () => ({
  loadCronSkill: async () => ({
    meta: { name: 'group-reminder-voice', whenToUse: 'x', task: 'speak', tools: [] },
    instructions: 'write',
  }),
}));

const { forceToolJson } = await import('~/lib/pipeline/structured');
const CLIENT = {} as AgentClient;

const FACTS: ConfirmFacts = {
  kind: 'confirm',
  language: 'en',
  audience: 'group',
  asker: 'Ruth',
  memberWords: 'Hale, remind me Thursday at 4 to grab Maya from swim',
  now: 'Wednesday, October 28, 2026 at 2:00 PM',
  set: [
    {
      forName: null,
      forEveryone: false,
      what: 'grab Maya from swim',
      when: 'Thursday, October 29, 2026 at 4:00 PM',
      askedFor: null,
      moved: null,
      arrives: 'here',
      privateAsked: false,
    },
  ],
  cancelled: [],
  needsTime: [],
  notSet: [],
};

afterEach(() => {
  vi.mocked(forceToolJson).mockReset();
});

describe('group reminder voice', () => {
  it('states the time as a full local fact', () => {
    expect(whenFact(new Date('2026-10-29T20:00:00.000Z'), 'America/Toronto')).toBe(
      'Thursday, October 29, 2026 at 4:00 PM',
    );
  });

  it('refuses only structure: empty, or a link, and never for length', () => {
    expect(groupReminderRefusals('Done, Ruth.')).toEqual([]);
    expect(groupReminderRefusals('   ')).toEqual(['empty']);
    expect(groupReminderRefusals('Done, Ruth. '.repeat(60))).toEqual([]);
    expect(groupReminderRefusals('see https://hale.app/r')).toEqual(['link']);
  });

  it('hands the model the facts and nothing it would have to invent', () => {
    expect(JSON.parse(groupReminderVoiceUserMessage(FACTS))).toEqual(FACTS);
  });

  it('returns the model text as written', async () => {
    vi.mocked(forceToolJson).mockResolvedValue({ value: { text: ' Done. ' } } as never);
    expect(await createGroupReminderVoice(CLIENT).write(FACTS)).toBe('Done.');
  });

  it('asks again after a refused text, then sends nothing', async () => {
    vi.mocked(forceToolJson).mockResolvedValue({ value: { text: '' } } as never);
    expect(await createGroupReminderVoice(CLIENT).write(FACTS)).toBeNull();
    expect(forceToolJson).toHaveBeenCalledTimes(2);
  });

  it('sends nothing when the model call fails', async () => {
    vi.mocked(forceToolJson).mockRejectedValue(new Error('boom'));
    expect(await createGroupReminderVoice(CLIENT).write(FACTS)).toBeNull();
  });
});
