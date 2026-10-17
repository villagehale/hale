import type { AgentClient } from '@hale/agent';
import { describe, expect, it, vi } from 'vitest';
import { isStage, structuredReply } from '~/lib/testing/structured-reply';
import {
  type RegistrationLinkReplyInput,
  composeRegistrationLinkReply,
  registrationLinkReplyContext,
} from './link-reply';

const sourceUrl = 'https://example.org/course';
const input: RegistrationLinkReplyInput = {
  outcome: 'registration_reminder_proposed',
  language: 'fr-CA',
  parentWords: 'Quand ouvrent les inscriptions ? [link]',
  sourceUrl,
  reading: {
    status: 'verified',
    reader: 'ai',
    sourceUrl,
    checkedAt: new Date('2026-10-16T20:00:00Z'),
    timeZone: 'America/Toronto',
    dates: [
      {
        kind: 'unclassified_open',
        date: '2026-11-10',
        time: '09:00',
        evidence: ['Registration opens November 10, 2026 at 9am'],
      },
    ],
  },
};
const when = '2026-11-10 at 09:00 America/Toronto';
function fake(message: string, parsed?: unknown[]) {
  // ASCII parser stand-in for request/guard mechanics only, not language quality.
  const date = message.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? null;
  const time = message.match(/\b\d{2}:\d{2}\b/)?.[0] ?? null;
  const timeZone = message.match(/(?:America|Europe)\/[A-Za-z_]+/)?.[0] ?? null;
  const create = vi.fn(async (request) =>
    isStage(request, 'registration_message_dates', 'openings')
      ? structuredReply(request, 'registration_message_dates', {
          openings:
            parsed ??
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
      : structuredReply(request, 'registration_link_reply', { message }),
  );
  return { client: { messages: { create } } as unknown as AgentClient, create };
}

describe('registration-link AI wording (mechanics, not language quality)', () => {
  it('preserves natural date and zone wording rather than appending an English fact string', async () => {
    const message =
      'Ouverture mardi 10 novembre à 9 h, heure de Toronto ; admissibilité à confirmer.';
    const parsed = {
      date: '2026-11-10',
      time: '09:00',
      timeZone: 'America/Toronto',
      weekday: 2,
      confidence: 'high',
      evidence: {
        date: '10 novembre',
        time: '9 h',
        timeZone: 'heure de Toronto',
        weekday: 'mardi',
      },
    };
    expect(await composeRegistrationLinkReply(input, fake(message, [parsed]).client)).toBe(
      `${message}\n${sourceUrl}`,
    );
  });
  it.each(['en', 'fr-CA', 'ar'])(
    'supplies facts and language without a parent-facing template: %s',
    async (language) => {
      const { client, create } = fake(`${when}. ${sourceUrl}`);
      expect(await composeRegistrationLinkReply({ ...input, language }, client)).toBe(
        `${when}. ${sourceUrl}`,
      );
      const request = create.mock.calls[0]![0] as { messages: { content: string }[] };
      expect(JSON.parse(request.messages[0]!.content)).toMatchObject({
        language,
        outcome: input.outcome,
        opening: { date: '2026-11-10', time: '09:00', timeZone: 'America/Toronto' },
        eligibility: 'unclassified_open',
        dateRemindersPaused: true,
        nextStep: 'confirm_plan_in_approvals',
      });
    },
  );
  it('does not invent precision or a minute reminder for a date-only source', () => {
    if (input.reading?.status !== 'verified') throw new Error('fixture');
    const context = registrationLinkReplyContext({
      ...input,
      reading: { ...input.reading, dates: [{ ...input.reading.dates[0]!, time: null }] },
    });
    expect(context.opening).toEqual({
      date: '2026-11-10',
      time: null,
      timeZone: 'America/Toronto',
      timePublished: false,
    });
    expect(context.reminderPlan.minutesBeforeOpening).toBeNull();
  });
  it.each([
    'Les inscriptions ouvrent le 2026-11-10 à 09:00 (America/Toronto).',
    'يفتح التسجيل 2026-11-10 الساعة 09:00 بتوقيت America/Toronto.',
  ])('retains published facts when connecting words are translated: %s', async (text) => {
    expect(await composeRegistrationLinkReply(input, fake(text).client)).toBe(
      `${text}\n${sourceUrl}`,
    );
  });
  it.each(['2026-11-10 America/Toronto', '2026-11-10 09:00', '2026-11-11 09:00 America/Toronto'])(
    'still refuses missing or changed date/time/zone facts: %s',
    async (text) => {
      expect(await composeRegistrationLinkReply(input, fake(text).client)).toBeNull();
    },
  );
  it.each(['A date is coming soon.', `${when} https://invented.example/`])(
    'refuses unsupported wording, no fixed fallback: %s',
    async (message) => {
      expect(await composeRegistrationLinkReply(input, fake(message).client)).toBeNull();
    },
  );
  it('retains a missing verified URL without clipping the generated words', async () => {
    const message = `${when}. ${'Préparation. '.repeat(80)}`;
    expect(await composeRegistrationLinkReply(input, fake(message).client)).toBe(
      `${message.trim()}\n${sourceUrl}`,
    );
  });
  it('reports writer failure as no reply, never a fixed English substitute', async () => {
    const client = {
      messages: {
        create: async () => {
          throw new Error('offline');
        },
      },
    } as unknown as AgentClient;
    expect(await composeRegistrationLinkReply(input, client)).toBeNull();
  });
});
