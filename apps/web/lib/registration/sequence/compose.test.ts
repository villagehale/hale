import { readFileSync } from 'node:fs';
import type { AgentClient } from '@hale/agent';
import { describe, expect, it, vi } from 'vitest';
import { registrationAcceptanceInput } from '~/lib/testing/registration-acceptance';
import { isStage, structuredReply } from '~/lib/testing/structured-reply';
import {
  type RegistrationReminderInput,
  composeRegistrationReminder,
  registrationReminderContext,
} from './compose';
import { courseShortlist } from './shortlist';

const source = 'https://venue.example/register';
const now = new Date('2026-10-16T14:00:00Z');
const input: RegistrationReminderInput = {
  leg: 'heads_up',
  resident: false,
  change: null,
  reading: {
    sourceUrl: source,
    timeZone: 'America/Toronto',
    checkedAt: now,
    reader: 'ai',
    status: 'verified',
    dates: [
      {
        kind: 'general_open',
        date: '2026-10-23',
        time: '06:30',
        evidence: ['October 23, 2026 at 6:30am'],
      },
    ],
  },
  copy: {
    shortlist: courseShortlist('private-sequence-id', source, now),
    now,
    timeZone: 'America/Toronto',
    optIn: 'opted_in',
    anchor: now,
    portal: null,
    readinessReady: null,
    prep: null,
  },
};
const when = '2026-10-23 at 06:30 America/Toronto';
function fake(message: string, parsed?: unknown[] | ((purpose: string) => unknown[])) {
  // ASCII parser stand-in for request/guard mechanics only, not language quality.
  const date = message.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? null;
  const time = message.match(/\b\d{2}:\d{2}\b/)?.[0] ?? null;
  const timeZone = message.match(/(?:America|Europe)\/[A-Za-z_]+/)?.[0] ?? null;
  const create = vi.fn(async (request) =>
    isStage(request, 'registration_message_dates', 'openings')
      ? structuredReply(request, 'registration_message_dates', {
          openings:
            (typeof parsed === 'function'
              ? parsed(JSON.parse(request.messages[0].content).purpose ?? 'registration_opening')
              : parsed) ??
            (date
              ? [
                  {
                    date,
                    time,
                    timeZone,
                    weekday: null,
                    confidence: 'high',
                    evidence: { date, time, timeZone, weekday: null },
                  },
                ]
              : []),
        })
      : structuredReply(request, 'registration_reminder', { message }),
  );
  return { client: { messages: { create } } as unknown as AgentClient, create };
}

describe('AI registration reminders (mechanics, not model quality)', () => {
  const recordings = JSON.parse(
    readFileSync(new URL('./__recordings__/localized.json', import.meta.url), 'utf8'),
  ) as Record<
    string,
    {
      recordedAt: string;
      request: { userMessage: string };
      response: { content: { type: string; text?: string }[] };
    }
  >;
  const captured = (language: string) => {
    const recording = Object.values(recordings)
      .filter((entry) => {
        const request = JSON.parse(entry.request.userMessage);
        return request.leg === 'waitlist_final' && request.language === language;
      })
      .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))[0]!;
    return JSON.parse(recording.response.content.find((block) => block.type === 'text')!.text!)
      .message as string;
  };
  it.each(['waitlist_half', 'waitlist_final'] as const)(
    'validates the captured English deadline without requiring an opening: %s',
    async (leg) => {
      const message = captured('en');
      const waitlist = { ...registrationAcceptanceInput('closing-soon', 'en'), leg };
      // Captured writer text; asserted parser values exercise code, not new model acceptance.
      const parsed = {
        date: '2026-08-12',
        time: '07:00',
        timeZone: 'America/Toronto',
        weekday: null,
        confidence: 'high',
        evidence: {
          date: 'August 12, 2026',
          time: '7:00 AM',
          timeZone: 'Toronto time',
          weekday: null,
        },
      };
      expect(message).toContain('7:00 AM');
      const { client, create } = fake(message, (purpose) =>
        purpose === 'waitlist_deadline' ? [parsed] : [],
      );
      expect(await composeRegistrationReminder(waitlist, client)).toBe(message);
      expect(create).toHaveBeenCalledTimes(3);
      const wire = JSON.parse(create.mock.calls[2]![0].messages[0].content);
      expect(wire).toEqual({
        message,
        now: waitlist.copy.now.toISOString(),
        purpose: 'waitlist_deadline',
      });
      for (const wrong of [
        { ...parsed, time: '08:00' },
        { ...parsed, date: '2026-08-13' },
      ]) {
        expect(
          await composeRegistrationReminder(
            waitlist,
            fake(message, (purpose) => (purpose === 'waitlist_deadline' ? [wrong] : [])).client,
          ),
        ).toBeNull();
      }
      expect(await composeRegistrationReminder(waitlist, fake(message, []).client)).toBeNull();
    },
  );
  it('holds the actual corrupted French draft before any date-parser call, without repair', async () => {
    const message = captured('fr-CA');
    expect(message).toContain('dĂ©but');
    const { client, create } = fake(message);
    expect(
      await composeRegistrationReminder(
        registrationAcceptanceInput('closing-soon', 'fr-CA'),
        client,
      ),
    ).toBeNull();
    expect(create).toHaveBeenCalledTimes(1);
  });
  it('still checks an opening mentioned in waitlist copy, and refuses a missing deadline', async () => {
    const waitlist: RegistrationReminderInput = {
      ...input,
      leg: 'waitlist_final',
      copy: { ...input.copy, waitlist: { position: 2, deadlineAt: new Date('2026-10-24T11:00Z') } },
    };
    const message = `Registration opened ${when}. Your deadline is 2026-10-24 at 07:00 America/Toronto.`;
    const fact = (date: string, time: string) => ({
      date,
      time,
      timeZone: 'America/Toronto',
      weekday: null,
      confidence: 'high',
      evidence: { date, time, timeZone: 'America/Toronto', weekday: null },
    });
    const reply = (opening: string) =>
      fake(message, (purpose) => [
        purpose === 'waitlist_deadline' ? fact('2026-10-24', '07:00') : fact('2026-10-23', opening),
      ]).client;
    expect(await composeRegistrationReminder(waitlist, reply('06:30'))).toBe(
      `${message}\n${source}`,
    );
    expect(await composeRegistrationReminder(waitlist, reply('07:00'))).toBeNull();
    expect(
      await composeRegistrationReminder({ ...waitlist, copy: input.copy }, reply('06:30')),
    ).toBeNull();
  });
  it('gives change notices the current opening, not the old scheduling anchor as a publishable fact', () => {
    const date = input.reading.status === 'verified' ? input.reading.dates[0]! : null;
    const context = registrationReminderContext({
      ...input,
      change: {
        kind: 'earlier',
        key: 'change',
        sourceUrl: source,
        previousAt: '2026-10-25T10:30:00Z',
        candidateAt: '2026-10-23T10:30:00Z',
        date,
        timeZone: 'America/Toronto',
        status: 'verified',
        notified: false,
      },
    });
    expect(context.change).toEqual({ kind: 'earlier' });
    expect(context.opening?.date).toBe('2026-10-23');
    expect(JSON.stringify(context)).not.toContain('2026-10-25');
  });
  it('sends naturally localized words when the independent parsed values match', async () => {
    const message = 'Ouverture vendredi 23 octobre à 6 h 30, heure de Toronto.';
    const parsed = {
      date: '2026-10-23',
      time: '06:30',
      timeZone: 'America/Toronto',
      weekday: 5,
      confidence: 'high',
      evidence: {
        date: '23 octobre',
        time: '6 h 30',
        timeZone: 'heure de Toronto',
        weekday: 'vendredi',
      },
    };
    expect(await composeRegistrationReminder(input, fake(message, [parsed]).client)).toBe(
      `${message}\n${source}`,
    );
  });
  it.each(['en', 'fr-CA', 'ar'])(
    'passes the stored language tag unchanged: %s',
    async (language) => {
      const text = `${when}. ${source}`;
      const { client, create } = fake(text);
      expect(await composeRegistrationReminder({ ...input, language }, client)).toBe(text);
      const request = create.mock.calls[0]![0] as { messages: { content: string }[] };
      expect(JSON.parse(request.messages[0]!.content)).toMatchObject({ language });
    },
  );
  it('sends generated wording, preserves the exact live time and appends its verified source', async () => {
    const text = `Just checked: ${when}. I'll send the evening-before plan.`;
    const { client, create } = fake(text);
    expect(await composeRegistrationReminder(input, client)).toBe(`${text}\n${source}`);
    const request = create.mock.calls[0]![0] as { messages: { content: string }[] };
    expect(request.messages[0]!.content).not.toContain('private-sequence-id');
    expect(request.messages[0]!.content).not.toContain('opensForFamilyAt');
    expect(JSON.parse(request.messages[0]!.content)).toMatchObject({
      opening: { date: '2026-10-23', time: '06:30', timeZone: 'America/Toronto' },
      optIn: 'opted_in',
    });
    expect(JSON.parse(request.messages[0]!.content)).not.toHaveProperty('when');
  });
  it.each([`Registration is soon. ${source}`, `${when}. https://evil.example/`])(
    'defers unsupported output instead of using a template: %s',
    async (text) => {
      expect(await composeRegistrationReminder(input, fake(text).client)).toBeNull();
    },
  );
  it('does not clip or reject a generated message based on character count', async () => {
    const text = `${when}. ${'Preparation information. '.repeat(35)}${source}`;
    expect(await composeRegistrationReminder(input, fake(text).client)).toBe(text);
  });
  it.each([
    'Les inscriptions ouvrent le 2026-10-23 à 06:30 (America/Toronto).',
    'يفتح التسجيل 2026-10-23 الساعة 06:30 بتوقيت America/Toronto.',
  ])('preserves live facts without requiring the English word at: %s', async (text) => {
    expect(await composeRegistrationReminder(input, fake(text).client)).toBe(`${text}\n${source}`);
  });
  it.each(['2026-10-23 America/Toronto', '2026-10-23 06:30', '2026-10-24 06:30 America/Toronto'])(
    'still holds missing or changed date/time/zone facts: %s',
    async (text) => {
      expect(await composeRegistrationReminder(input, fake(text).client)).toBeNull();
    },
  );
  it('preserves date-only precision and does not resurrect the cached anchor after an unavailable read', () => {
    const reading = {
      ...input.reading,
      status: 'verified' as const,
      dates: [
        {
          kind: 'general_open' as const,
          date: '2026-10-23',
          time: null,
          evidence: ['October 23, 2026'],
        },
      ],
    };
    expect(registrationReminderContext({ ...input, reading }).opening).toEqual({
      date: '2026-10-23',
      time: null,
      timeZone: 'America/Toronto',
      timePublished: false,
    });
    const unavailable = {
      ...input.reading,
      status: 'unreadable' as const,
      reason: 'fetch_failed' as const,
    };
    expect(registrationReminderContext({ ...input, reading: unavailable }).opening).toBeNull();
  });
  it('defers on provider failure, without a deterministic fallback', async () => {
    const client = {
      messages: {
        create: async () => {
          throw new Error('unavailable');
        },
      },
    } as unknown as AgentClient;
    expect(await composeRegistrationReminder(input, client)).toBeNull();
  });
});
