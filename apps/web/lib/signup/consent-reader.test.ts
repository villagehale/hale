import type { AgentClient } from '@hale/agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSignupConsentReader, signupConsentUserMessage } from './consent-reader';
import type { SignupOffer } from './types';

const OFFER: SignupOffer = {
  id: 'offer-1',
  familyId: 'family-1',
  childId: 'child-1',
  activityKey: 'swim-parent-tot',
  registrationUrl: 'https://example.test/register',
  approvedPriceCents: null,
  sessions: [
    {
      id: 'tue-1630',
      label: 'Tue 4:30',
      startsAt: '2026-10-06T20:30:00.000Z',
      endsAt: '2026-10-06T21:15:00.000Z',
      full: false,
      priceCents: null,
    },
    {
      id: 'wed-1000',
      label: 'Wed 10:00',
      startsAt: '2026-10-07T14:00:00.000Z',
      endsAt: '2026-10-07T14:45:00.000Z',
      full: false,
      priceCents: null,
    },
  ],
};

/** A mocked model: returns the tool input it is given and records the request. */
function mockModel(output: Record<string, unknown>) {
  const requests: { system: unknown; messages: unknown }[] = [];
  const client = {
    messages: {
      create: async (request: { system: unknown; messages: unknown }) => {
        requests.push(request);
        return {
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: JSON.stringify(output) }],
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      },
    },
  } as unknown as AgentClient;
  return { client, requests };
}

beforeEach(() => {
  vi.stubEnv('HALE_LLM_NO_STREAM', '1');
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('signup consent reader (mocked model)', () => {
  it('passes the offer and its sessions with the parent text, and no child data', () => {
    const body = JSON.parse(signupConsentUserMessage({ text: 'yes', offer: OFFER }));
    expect(body.offer.sessions.map((s: { id: string }) => s.id)).toEqual(['tue-1630', 'wed-1000']);
    expect(body.offer.registrationUrl).toBe(OFFER.registrationUrl);
    expect(body.text).toBe('yes');
    expect(JSON.stringify(body)).not.toContain('child-1');
  });

  it.each([
    ['Sure, go ahead and grab Wednesday', 'wed-1000'],
    ['Oui, inscris-la au cours du mardi', 'tue-1630'],
    ['好的，帮我们报名周三那节', 'wed-1000'],
    ['네, 화요일 수업으로 등록해 주세요', 'tue-1630'],
    ['نعم، سجّلها يوم الأربعاء', 'wed-1000'],
  ])('consent in varied wording and scripts: %s', async (text, sessionId) => {
    const { client, requests } = mockModel({ verdict: 'consent', sessionId, question: null });
    const reader = createSignupConsentReader(() => client);
    await expect(reader.read({ text, offer: OFFER })).resolves.toEqual({
      verdict: 'consent',
      sessionId,
    });
    expect(JSON.stringify(requests[0]?.messages)).toContain('tue-1630');
  });

  it.each(['No thanks, not this term', '先不用了', 'لا، شكراً'])('refusal: %s', async (text) => {
    const { client } = mockModel({ verdict: 'decline', sessionId: null, question: null });
    const reader = createSignupConsentReader(() => client);
    await expect(reader.read({ text, offer: OFFER })).resolves.toEqual({ verdict: 'decline' });
  });

  it('ambiguous reply comes back with one clarifying question', async () => {
    const { client } = mockModel({
      verdict: 'unclear',
      sessionId: null,
      question: '你想报周二还是周三那节？',
    });
    const reader = createSignupConsentReader(() => client);
    await expect(reader.read({ text: '可以吧，看哪天方便', offer: OFFER })).resolves.toEqual({
      verdict: 'unclear',
      question: '你想报周二还是周三那节？',
    });
  });

  it('an unclear verdict with no usable question is unreadable, not consent', async () => {
    const { client } = mockModel({ verdict: 'unclear', sessionId: null, question: null });
    const reader = createSignupConsentReader(() => client);
    vi.spyOn(console, 'info').mockImplementation(() => {});
    await expect(reader.read({ text: 'maybe', offer: OFFER })).resolves.toBeNull();
  });

  it('a session the offer does not have is never consent', async () => {
    const { client } = mockModel({
      verdict: 'consent',
      sessionId: 'fri-0900',
      question: 'I only see Tuesday and Wednesday. Which one?',
    });
    const reader = createSignupConsentReader(() => client);
    await expect(reader.read({ text: 'Book Friday', offer: OFFER })).resolves.toEqual({
      verdict: 'unclear',
      question: 'I only see Tuesday and Wednesday. Which one?',
    });
  });

  it('unrelated messages are left for other handlers', async () => {
    const { client } = mockModel({ verdict: 'unrelated', sessionId: null, question: null });
    const reader = createSignupConsentReader(() => client);
    await expect(reader.read({ text: "what's the weather", offer: OFFER })).resolves.toEqual({
      verdict: 'unrelated',
    });
  });

  it('no model is unreadable and does not log the parent text', async () => {
    const logged = vi.spyOn(console, 'info').mockImplementation(() => {});
    const reader = createSignupConsentReader(() => null);
    const text = '好的，报名吧';
    await expect(reader.read({ text, offer: OFFER })).resolves.toBeNull();
    expect(JSON.stringify(logged.mock.calls)).toContain('client_unavailable');
    expect(JSON.stringify(logged.mock.calls)).not.toContain(text);
  });

  it('a model failure is unreadable', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const client = {
      messages: {
        create: async () => {
          throw new Error('boom');
        },
      },
    } as unknown as AgentClient;
    const reader = createSignupConsentReader(() => client);
    await expect(reader.read({ text: 'yes', offer: OFFER })).resolves.toBeNull();
  });
});
