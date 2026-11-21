import type { AgentClient } from '@hale/agent';
import { describe, expect, it, vi } from 'vitest';
import { createSpokenLineWriter } from '~/lib/channel/spoken-line';
import { caregiverReminderModelCopyEnabled, caregiverReminderRequest } from './compose';

const TZ = 'America/Toronto';

describe('caregiverReminderModelCopyEnabled', () => {
  it('is on only for the exact value true', () => {
    expect(caregiverReminderModelCopyEnabled({})).toBe(false);
    expect(
      caregiverReminderModelCopyEnabled({ CAREGIVER_REMINDER_MODEL_COPY_ENABLED: 'true' }),
    ).toBe(true);
    for (const value of ['true\n', ' true', 'TRUE', 'True', '1', 'on', 'yes', '']) {
      expect(
        caregiverReminderModelCopyEnabled({ CAREGIVER_REMINDER_MODEL_COPY_ENABLED: value }),
      ).toBe(false);
    }
  });
});

describe('caregiverReminderRequest', () => {
  it('hands the evening-before batch its facts, numbered, with each place verbatim once', () => {
    const request = caregiverReminderRequest({
      offset: '-P1D',
      timeZone: TZ,
      now: new Date('2026-07-24T22:00:00Z'),
      language: 'fr',
      events: [
        {
          title: ' Swim class ',
          startsAt: new Date('2026-07-25T14:00:00Z'),
          endsAt: new Date('2026-07-25T14:45:00Z'),
          location: 'Memorial Park',
        },
        {
          title: 'PA day camp',
          startsAt: new Date('2026-07-26T04:00:00Z'),
          endsAt: new Date('2026-07-27T04:00:00Z'),
          location: null,
        },
        {
          title: 'Soccer',
          startsAt: new Date('2026-07-25T18:00:00Z'),
          endsAt: null,
          location: ' Memorial Park ',
        },
      ],
    });

    expect(request).toEqual({
      purpose: 'caregiver_reminder',
      language: 'fr',
      facts: {
        when: 'evening_before',
        count: '3',
        event_1: 'Swim class',
        date_1: 'Saturday, July 25, 2026',
        day_1: 'tomorrow',
        start_1: '10:00 AM',
        place_1: 'Memorial Park',
        event_2: 'PA day camp',
        date_2: 'Sunday, July 26, 2026',
        all_day_2: 'true',
        event_3: 'Soccer',
        date_3: 'Saturday, July 25, 2026',
        day_3: 'tomorrow',
        start_3: '2:00 PM',
        place_3: 'Memorial Park',
      },
      verbatim: ['Memorial Park'],
      addendum: 'caregiver-reminder',
    });
  });

  it('counts the minutes to the start on the hour-before reminder only', () => {
    const request = caregiverReminderRequest({
      offset: '-PT1H',
      timeZone: TZ,
      now: new Date('2026-07-25T19:15:00Z'),
      language: 'en',
      events: [
        {
          title: 'Swim class',
          startsAt: new Date('2026-07-25T20:15:00Z'),
          endsAt: null,
          location: null,
        },
      ],
    });
    expect(request.facts).toMatchObject({
      when: 'hour_before',
      day_1: 'today',
      start_1: '4:15 PM',
      minutes_until_1: '60',
    });
    expect(request.verbatim).toEqual([]);
  });
});

describe('a place that holds a keyword as a word', () => {
  const PLACE = 'BUS STOP 14, King St';
  const request = caregiverReminderRequest({
    offset: '-PT1H',
    timeZone: TZ,
    now: new Date('2026-07-25T19:15:00Z'),
    language: 'en',
    events: [
      {
        title: 'Pickup',
        startsAt: new Date('2026-07-25T20:15:00Z'),
        endsAt: null,
        location: PLACE,
      },
    ],
  });

  /** The client port handing back one fixed draft, so the real writer's acceptance runs. */
  function writerDrafting(text: string) {
    const client = (): AgentClient =>
      ({
        messages: {
          create: async () => ({
            // Both shapes, so the stub does not depend on which the lane's request uses.
            content: [
              { type: 'text', text: JSON.stringify({ text }) },
              { type: 'tool_use', id: 'draft', name: 'spoken_line', input: { text } },
            ],
            stop_reason: 'end_turn',
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
        },
      }) as unknown as AgentClient;
    return createSpokenLineWriter(client, { page: async () => 'paged' });
  }

  it('sends a faithful draft', async () => {
    const draft = `Pickup at 4:15 today at ${PLACE}.`;
    await expect(writerDrafting(draft).write(request)).resolves.toBe(draft);
  });

  it('still holds a draft that drops the place', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(writerDrafting('Pickup at 4:15 today.').write(request)).resolves.toBeNull();
    vi.restoreAllMocks();
  });

  it('still holds a draft that teaches the keyword around the place', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const taught = `Pickup at 4:15 at ${PLACE}. Reply STOP to leave.`;
    await expect(writerDrafting(taught).write(request)).resolves.toBeNull();
    vi.restoreAllMocks();
  });
});
