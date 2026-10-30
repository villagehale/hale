import type { AgentClient } from '@hale/agent';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GROUP_REMINDER_READ_SCHEMA,
  type GroupReminderReadInput,
  createGroupReminderReader,
  groupReminderReadUserMessage,
  readerNow,
} from './read';

vi.mock('~/lib/pipeline/structured', () => ({ forceToolJson: vi.fn() }));
vi.mock('~/lib/cron/skill', () => ({
  loadCronSkill: async () => ({
    meta: { name: 'group-reminder-read', whenToUse: 'x', task: 'screen', tools: [] },
    instructions: 'read',
  }),
}));

const { forceToolJson } = await import('~/lib/pipeline/structured');
const CLIENT = {} as AgentClient;
const NOW = new Date('2026-10-28T18:00:00.000Z');

const INPUT: GroupReminderReadInput = {
  message: 'Hale, remind me Thursday at 4 to grab Maya from swim',
  sender: 'Ruth',
  people: ['Priya', 'Dan'],
  recent: [],
  now: readerNow(NOW, 'America/Toronto'),
  open: [],
};

const READING = {
  request: 'reminders' as const,
  set: [
    {
      for: 'sender' as const,
      name: null,
      what: 'grab Maya from swim',
      date: '2026-10-29',
      time: '16:00',
      inMinutes: null,
      where: 'unsaid' as const,
    },
  ],
  cancel: [],
  language: 'en',
};

afterEach(() => {
  vi.mocked(forceToolJson).mockReset();
});

describe('group reminder reader', () => {
  it('gives the model the local day, clock and the week ahead', () => {
    const now = readerNow(NOW, 'America/Toronto');
    expect(now).toMatchObject({ date: '2026-10-28', weekday: 'Wednesday', time: '14:00' });
    expect(now.nextDays[0]).toEqual({ date: '2026-10-28', weekday: 'Wednesday' });
    expect(now.nextDays[1]).toEqual({ date: '2026-10-29', weekday: 'Thursday' });
    expect(now.nextDays[7]).toEqual({ date: '2026-11-04', weekday: 'Wednesday' });
    expect(now.nextDays).toHaveLength(8);
  });

  it('sends the message, the names and at most six recent lines', () => {
    const recent = Array.from({ length: 9 }, (_, i) => ({
      from: 'member' as const,
      text: `m${i}`,
    }));
    const payload = JSON.parse(groupReminderReadUserMessage({ ...INPUT, recent }));
    expect(payload.message).toBe(INPUT.message);
    expect(payload.people).toEqual(['Priya', 'Dan']);
    expect(payload.recent).toHaveLength(6);
    expect(payload.recent[5].text).toBe('m8');
  });

  it('forces a strict schema with no free-form fields', () => {
    expect(GROUP_REMINDER_READ_SCHEMA.additionalProperties).toBe(false);
    expect(GROUP_REMINDER_READ_SCHEMA.required).toEqual(['request', 'set', 'cancel', 'language']);
  });

  it('returns the reading on the screen lane', async () => {
    vi.mocked(forceToolJson).mockResolvedValue({ value: READING } as never);
    expect(await createGroupReminderReader(CLIENT).read(INPUT)).toEqual(READING);
    const call = vi.mocked(forceToolJson).mock.calls[0]?.[0] as { toolName: string };
    expect(call.toolName).toBe('group_reminder_read');
  });

  it('retries once, then returns null so the coach answers', async () => {
    vi.mocked(forceToolJson).mockRejectedValue(new Error('boom'));
    expect(await createGroupReminderReader(CLIENT).read(INPUT)).toBeNull();
    expect(forceToolJson).toHaveBeenCalledTimes(2);
  });
});
