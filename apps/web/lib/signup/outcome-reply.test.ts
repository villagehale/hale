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
  linkIs: 'registration_page',
  holdMinutes: null,
  audience: 'direct',
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
      'This one needs you: https://register.example-rec.test/activity/42 — for Tue 4:30 have parent_first_name Test Parent ready.';
    const { client, requests } = mockModel([sample]);
    const text = await createSignupOutcomeWriter(() => client).write({
      ...BASE,
      outcome: 'assisted_handoff',
      reason: 'assisted_handoff',
      link: 'https://register.example-rec.test/activity/42',
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

  it('flags an extra link and a link where none belongs, naming the word', () => {
    expect(
      signupOutcomeViolations('See https://example.test/register and https://evil.test', BASE),
    ).toContain('contains another link: https://evil.test');
    expect(signupOutcomeViolations('Done: https://x.test', { ...BASE, link: '' })).toContain(
      'contains a link: https://x.test',
    );
  });

  it("passes the parent's own email from the pack, and refuses the same shape from anywhere else", () => {
    const draft = `Sign up here: ${BASE.link}. Have ready: your email sam@example.test.`;
    const packed = { ...BASE, pack: [{ slot: 'parent_email', value: 'sam@example.test' }] };
    expect(signupOutcomeViolations(draft, packed)).toEqual([]);
    expect(signupOutcomeViolations(draft, BASE)).toEqual([
      'contains another link: sam@example.test',
    ]);
  });

  it('reads Hale or a packed name after a Chinese full stop as a new sentence', () => {
    const draft = `这一场没有空位了。Hale不会自动加入候补,可以在这里自己操作:${BASE.link}`;
    expect(signupOutcomeViolations(draft, BASE)).toEqual([]);
    expect(signupOutcomeViolations(`这一场没有空位了。evil不会:${BASE.link}`, BASE)).not.toEqual(
      [],
    );
  });

  it('names the link to the retry but logs only the code', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const { client, requests } = mockModel([`Here: ${BASE.link} or bit.ly/x`]);
    await expect(createSignupOutcomeWriter(() => client).write(BASE)).resolves.toBeNull();
    expect(requests[1]).toContain('contains another link: bit.ly/x');
    expect(JSON.stringify(info.mock.calls)).toContain('contains another link');
    expect(JSON.stringify(info.mock.calls)).not.toContain('bit.ly');
  });

  it('leaves length to the model: a long draft that carries the link can send', () => {
    const long = `${'Here is what to have ready for the form. '.repeat(14)}${BASE.link}`;
    expect(long.length).toBeGreaterThan(480);
    expect(signupOutcomeViolations(long, BASE)).toEqual([]);
  });

  it('holds a live-browser draft to the live link, not the registration page', () => {
    const live: SignupOutcomeFacts = {
      ...BASE,
      outcome: 'reached_checkout',
      reason: null,
      link: 'https://live.browser-use.com/s/fixture-live-view-token',
      linkIs: 'live_browser',
      holdMinutes: 10,
    };
    const violations = signupOutcomeViolations(`Finish it here: ${BASE.link}`, live);
    expect(violations).toContain('missing the hand-off link');
    expect(violations).toContain(`contains another link: ${BASE.link}`);
    expect(signupOutcomeViolations(`Finish it here: ${live.link}`, live)).toEqual([]);
  });
});
