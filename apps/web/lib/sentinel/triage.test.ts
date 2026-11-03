import { type AgentClient, HAIKU_MODEL } from '@hale/agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { evaluateJevChoice } from '~/lib/pipeline/jev';
import { clearForNonAnthropic } from '~/lib/pipeline/provider-clearance';
import { triageEmail } from './triage';

function client(childRelated: boolean): AgentClient {
  return {
    messages: {
      create: vi.fn(async () => ({
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              child_related: childRelated,
              confidence: 0.9,
              rationale: 'fixture',
            }),
          },
        ],
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          cache_creation_input_tokens: null,
          cache_read_input_tokens: null,
        },
      })),
    },
  } as unknown as AgentClient;
}

const envelope = {
  subject: 'Swim lesson moved',
  from: 'coach@example.com',
  snippet: 'The Tuesday class starts at 4:30pm now',
};

/** A confident JEV "no": on a path that reached the gateway, Haiku would not run. */
const JEV_CONFIDENT_NO = {
  answers: { child_related: { choice: 'no', probabilities: { yes: 0.01, no: 0.99 } } },
  usage: { inputTokens: 20, outputTokens: 1 },
};

const GATEWAY_HOST = 'ai-gateway.vercel.sh';

// NO NETWORK, red or green: the global fetch is replaced (never spied through), the
// gateway keys are stubbed, and the Anthropic key is blanked so an accidental default
// Anthropic client throws instead of calling out.
let globalHosts: string[];
beforeEach(() => {
  globalHosts = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL) => {
      globalHosts.push(new URL(String(url)).host);
      return Response.json(JEV_CONFIDENT_NO);
    }),
  );
  vi.stubEnv('AI_GATEWAY_API_KEY', 'test-key-no-network');
  vi.stubEnv('VERCEL_KEY', '');
  vi.stubEnv('JEV_KEY', '');
  vi.stubEnv('ANTHROPIC_API_KEY', '');
  vi.stubEnv('HALE_TRIAGE_MODEL_MODE', '');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('triageEmail rollout', () => {
  it.each([undefined, '', ' \t\n ', 'invalid', 'shadow', 'current'])(
    'keeps Haiku for model mode %j',
    async (raw) => {
      vi.stubEnv('HALE_TRIAGE_MODEL_MODE', raw);
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const currentClient = client(false);
      const evaluateChoice = vi.fn(async () => ({
        choice: 'yes' as const,
        probabilities: { yes: 0.95, no: 0.05 },
        confidence: 0.9,
        usage: { inputTokens: 20, outputTokens: 1 },
      }));

      const result = await triageEmail(envelope, ['Ada'], currentClient, {
        evaluateChoice,
      });

      expect(result.childRelated).toBe(false);
      expect(evaluateChoice).not.toHaveBeenCalled();
      expect(currentClient.messages.create).toHaveBeenCalledTimes(1);
    },
  );

  it('uses Haiku when current mode is explicit, and names no refusal', async () => {
    const currentClient = client(false);
    const result = await triageEmail(envelope, ['Ada'], currentClient, {
      modelMode: 'current',
    });

    expect(result.childRelated).toBe(false);
    expect(result.candidateRefusal).toBeNull();
    expect(currentClient.messages.create).toHaveBeenCalledTimes(1);
  });
});

/**
 * VIL-556: a Gmail envelope is Google user data, so the candidate (JEV on the Vercel AI
 * Gateway) never sees it, whatever HALE_TRIAGE_MODEL_MODE says. This asserts ROUTING,
 * not model behaviour: which transport is called, with nothing from the model checked.
 */
describe('triageEmail · Gmail envelopes reach Anthropic only', () => {
  it('candidate mode refuses the JEV transport, runs Haiku and names the refusal', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const currentClient = client(true);
    const evaluateChoice = vi.fn(async () => ({
      choice: 'no' as const,
      probabilities: { yes: 0.01, no: 0.99 },
      confidence: 0.99,
      usage: { inputTokens: 20, outputTokens: 1 },
    }));

    const result = await triageEmail(envelope, ['Ada'], currentClient, {
      modelMode: 'candidate',
      evaluateChoice,
    });

    expect(evaluateChoice).not.toHaveBeenCalled();
    expect(currentClient.messages.create).toHaveBeenCalledTimes(1);
    expect(currentClient.messages.create).toHaveBeenCalledWith(
      expect.objectContaining({ model: HAIKU_MODEL }),
    );
    expect(result.childRelated).toBe(true);
    expect(result.candidateRefusal).toBe('google_derived_input');
    expect(warn.mock.calls.map((call) => call[0])).toContainEqual({
      stage: 'sentinel triage',
      refusal: 'google_derived_input',
    });
  });

  it('candidate set only in env, with the default transport: nothing reaches the gateway', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('HALE_TRIAGE_MODEL_MODE', 'candidate');
    const currentClient = client(true);

    const result = await triageEmail(envelope, ['Ada'], currentClient);

    expect(globalHosts.filter((host) => host === GATEWAY_HOST)).toEqual([]);
    expect(currentClient.messages.create).toHaveBeenCalledTimes(1);
    expect(result.candidateRefusal).toBe('google_derived_input');
  });

  it('positive control: the global stub does record a gateway request when one is made', async () => {
    const decision = await clearForNonAnthropic({ kind: 'parent_text' }, 'triage test');
    if (!('cleared' in decision)) throw new Error('expected a clearance for parent text');

    await evaluateJevChoice(
      {
        state: { text: 'invented control input' },
        question: 'child_related',
        instructions: 'Control.',
        criteria: { yes: 'Yes.', no: 'No.' },
      },
      decision.cleared,
    );

    expect(globalHosts).toEqual([GATEWAY_HOST]);
  });
});
