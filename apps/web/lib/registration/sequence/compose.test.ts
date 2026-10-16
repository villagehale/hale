import type { AgentClient } from '@hale/agent';
import { describe, expect, it, vi } from 'vitest';
import { structuredReply } from '~/lib/testing/structured-reply';
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
function fake(message: string) {
  const create = vi.fn(async (request) =>
    structuredReply(request, 'registration_reminder', { message }),
  );
  return { client: { messages: { create } } as unknown as AgentClient, create };
}

describe('AI registration reminders (mechanics, not model quality)', () => {
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
    expect(JSON.parse(request.messages[0]!.content)).toMatchObject({ when, optIn: 'opted_in' });
  });
  it.each([
    `Registration is soon. ${source}`,
    `${when}. https://evil.example/`,
    `${when}. Reply STOP to opt out.`,
  ])('defers unsupported output instead of using a template: %s', async (text) => {
    expect(await composeRegistrationReminder(input, fake(text).client)).toBeNull();
  });
  it('does not clip or reject a generated message based on character count', async () => {
    const text = `${when}. ${'Preparation information. '.repeat(35)}${source}`;
    expect(await composeRegistrationReminder(input, fake(text).client)).toBe(text);
  });
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
    expect(registrationReminderContext({ ...input, reading }).when).toContain('2026-10-23');
    expect(registrationReminderContext({ ...input, reading }).when).not.toContain('00:00');
    const unavailable = {
      ...input.reading,
      status: 'unreadable' as const,
      reason: 'fetch_failed' as const,
    };
    expect(registrationReminderContext({ ...input, reading: unavailable }).when).toBeNull();
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
