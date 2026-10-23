import type { AgentClient } from '@hale/agent';
import { describe, expect, it, vi } from 'vitest';
import { structuredReply } from '~/lib/testing/structured-reply';
import { createRegistrationRequestReader } from './request-read';

describe('registration request reading (model mechanics, not language accuracy)', () => {
  it('passes the whole request as data and accepts a structured intent without word matching', async () => {
    const input = {
      text: 'Préviens-moi quand les inscriptions ouvrent. https://example.org/cours',
      sourceUrl: 'https://example.org/cours',
      location: null,
    };
    const value = { intent: 'remind', confidence: 'high', needsLocation: false };
    const create = vi.fn(async (request) =>
      structuredReply(request, 'registration_request', value),
    );
    const reader = createRegistrationRequestReader({
      messages: { create },
    } as unknown as AgentClient);
    expect(await reader(input)).toEqual(value);
    const request = create.mock.calls[0]![0] as { messages: { content: string }[] };
    expect(JSON.parse(request.messages[0]!.content)).toEqual(input);
  });

  it('fails visibly without a keyword fallback when the model is unavailable', async () => {
    const create = vi.fn(async () => {
      throw new Error('provider unavailable');
    });
    const reader = createRegistrationRequestReader({
      messages: { create },
    } as unknown as AgentClient);
    expect(
      await reader({
        text: 'remind me https://example.org',
        sourceUrl: 'https://example.org',
        location: null,
      }),
    ).toBeNull();
  });
});
