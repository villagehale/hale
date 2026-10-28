import type { AgentClient } from '@hale/agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type SignupOfferFacts,
  createSignupOfferWriter,
  signupOfferUserMessage,
  signupOfferViolations,
} from './offer-writer';
import { SIGNUP_OFFER_SENTENCE_TODO } from './offer-copy';

const URL = 'https://harbor-rec.example/register';
const BASE: SignupOfferFacts = {
  source: 'email',
  evidence: 'Fall parent and tot swim, Tuesday 4:30, forty dollars.',
  registrationUrl: URL,
  sessions: [
    {
      id: 'tue-1630',
      label: 'Tue 4:30',
      startsAt: '2026-11-03T20:30:00.000Z',
      endsAt: '2026-11-03T21:15:00.000Z',
      full: false,
      priceCents: 4000,
    },
  ],
  approvedPriceCents: 4000,
  childFirstName: 'Ada',
  language: null,
};

function mockModel(texts: string[]) {
  const requests: string[] = [];
  const client = {
    messages: {
      create: async (request: { messages: { content: unknown }[] }) => {
        requests.push(JSON.stringify(request.messages));
        const text = texts[Math.min(requests.length - 1, texts.length - 1)];
        return {
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: JSON.stringify({ text }) }],
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

describe('signup offer writer', () => {
  it('gives the model the facts Hale saw, not a locked sentence', async () => {
    const sample = `The rec email has Tue 4:30 parent-and-tot swim. I can try ${URL} and stop at checkout.`;
    const { client, requests } = mockModel([sample]);
    const text = await createSignupOfferWriter(() => client).write(BASE);
    expect(text).toBe(sample);
    expect(requests[0]).toContain('\\"source\\":\\"email\\"');
    expect(requests[0]).toContain('Fall parent and tot swim');
    expect(requests[0]).not.toContain(SIGNUP_OFFER_SENTENCE_TODO);
  });

  it('refuses a draft that drops the page or every session Hale saw', () => {
    expect(signupOfferViolations('Want me to try?', BASE)).toEqual([
      'missing the registration link',
      'missing a session Hale saw',
    ]);
    expect(signupOfferViolations(`Tue 4:30 at ${URL} and also https://evil.example`, BASE)).toEqual([
      'contains another link',
    ]);
  });

  it('names a missing client instead of falling back to a template', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const text = await createSignupOfferWriter(() => null).write(BASE);
    expect(text).toBeNull();
  });

  it('packs the facts the eval and the runtime share', () => {
    const packed = signupOfferUserMessage(BASE);
    expect(packed).toContain('"source":"email"');
    expect(packed).toContain(URL);
    expect(packed).toContain('Tue 4:30');
  });
});
