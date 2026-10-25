import type { AgentClient } from '@hale/agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type SignupOutcomeFacts,
  createSignupOutcomeWriter,
  signupOutcomeViolations,
} from './outcome-reply';

const BASE: SignupOutcomeFacts = {
  outcome: 'payment',
  reason: 'payment',
  confirmed: false,
  sessionLabel: 'Tue 4:30',
  link: 'https://example.test/register',
  prefilled: ['child_first_name'],
  rush: null,
  question: null,
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

describe('signup outcome reply (mocked model)', () => {
  it('gives the model the structured outcome, including confirmed', async () => {
    const sample =
      'It got to the payment step, so that part is yours: https://example.test/register — I filled in the first name.';
    const { client, requests } = mockModel([sample]);
    const text = await createSignupOutcomeWriter(() => client).write(BASE);
    expect(text).toBe(sample);
    expect(requests[0]).toContain('\\"confirmed\\":false');
    expect(requests[0]).toContain('\\"outcome\\":\\"payment\\"');
  });

  it('writes a confirmed completion from the facts', async () => {
    const sample = "You're all set for Tue 4:30 — the provider confirmed it.";
    const { client } = mockModel([sample]);
    const text = await createSignupOutcomeWriter(() => client).write({
      ...BASE,
      outcome: 'completed',
      reason: null,
      confirmed: true,
      link: '',
    });
    expect(text).toBe(sample);
  });

  it('retries once when the hand-off link is missing, then sends nothing', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const { client, requests } = mockModel(['That part is yours.']);
    await expect(createSignupOutcomeWriter(() => client).write(BASE)).resolves.toBeNull();
    expect(requests).toHaveLength(2);
    expect(requests[1]).toContain('missing the hand-off link');
  });

  it('writes the assisted handoff from the pack and the page', async () => {
    const sample =
      'This one needs you: https://www.toronto.ca/register — for Tue 4:30 have parent_first_name Test Parent ready.';
    const { client, requests } = mockModel([sample]);
    const text = await createSignupOutcomeWriter(() => client).write({
      ...BASE,
      outcome: 'assisted_handoff',
      reason: 'assisted_handoff',
      link: 'https://www.toronto.ca/register',
      prefilled: [],
      pack: [{ slot: 'parent_first_name', value: 'Test Parent' }],
    });
    expect(text).toBe(sample);
    expect(requests[0]).toContain('parent_first_name');
  });

  it('no model sends nothing (no fixed fallback)', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    await expect(createSignupOutcomeWriter(() => null).write(BASE)).resolves.toBeNull();
  });

  it('flags an extra link and a link where none belongs', () => {
    expect(
      signupOutcomeViolations('See https://example.test/register and https://evil.test', BASE),
    ).toContain('contains another link');
    expect(signupOutcomeViolations('Done: https://x.test', { ...BASE, link: '' })).toContain(
      'contains a link',
    );
  });
});
