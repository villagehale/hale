import type { AgentClient } from '@hale/agent';
import { describe, expect, it, vi } from 'vitest';
import { acceptSpokenRequest, createSpokenLineWriter } from '~/lib/channel/spoken-line';
import { caregiverReminderModelCopyEnabled, caregiverReminderRequest } from './compose';

const TZ = 'America/Toronto';

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
      mayRepeat: ['Swim class', 'PA day camp', 'Soccer'],
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

describe('an event title that holds a keyword as a word', () => {
  const requestFor = (title: string) =>
    caregiverReminderRequest({
      offset: '-PT1H',
      timeZone: TZ,
      now: new Date('2026-07-25T19:15:00Z'),
      language: 'en',
      events: [
        {
          title,
          startsAt: new Date('2026-07-25T20:15:00Z'),
          endsAt: null,
          location: 'Memorial Park',
        },
      ],
    });

  it.each([
    'BUS STOP pickup',
    'HELP at the bake sale',
    'Teacher AIDE meeting',
    'PIT STOP with Grandma',
  ])('sends a draft that repeats "%s" as written', async (title) => {
    const draft = `${title} is today at 4:15 PM at Memorial Park.`;
    expect(acceptSpokenRequest(draft, requestFor(title))).toBe(draft);
    await expect(writerDrafting(draft).write(requestFor(title))).resolves.toBe(draft);
  });

  it('positive control: the same draft is refused when that title is not the event', () => {
    const draft = 'BUS STOP pickup is today at 4:15 PM at Memorial Park.';
    expect(acceptSpokenRequest(draft, requestFor('Swim class'))).toBeNull();
  });

  it('still refuses a keyword taught around the title', () => {
    const draft = 'BUS STOP pickup is today at 4:15 PM at Memorial Park. Reply STOP to leave.';
    expect(acceptSpokenRequest(draft, requestFor('BUS STOP pickup'))).toBeNull();
  });

  it.each([
    'Reply STOP if you cannot make it',
    'Text HELP to skip this one',
    'You can opt out with the word stop',
  ])('refuses a title that is itself the instruction: %s', (title) => {
    const draft = `${title}, today at 4:15 PM at Memorial Park.`;
    expect(acceptSpokenRequest(draft, requestFor(title))).toBeNull();
  });

  it('does not let a title carry a contact past the contact check', () => {
    const title = 'Pickup, call 416-555-0100';
    expect(
      acceptSpokenRequest(`${title}, today at 4:15 PM at Memorial Park.`, requestFor(title)),
    ).toBeNull();
  });
});
