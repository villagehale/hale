import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { evaluateJevChoice, meetsJevConfidence } from './jev';
import {
  type NonGoogleClearance,
  ProviderClearanceError,
  clearForNonAnthropic,
} from './provider-clearance';

const JEV_BODY = {
  answers: {
    intent: { choice: 'yes', probabilities: { yes: 0.9, no: 0.1 } },
  },
  usage: { inputTokens: 12, outputTokens: 1 },
  providerMetadata: { typesafe: { confidence: { intent: 0.8 } } },
};

const ARGS = {
  state: { reply: 'yes' },
  question: 'intent',
  instructions: 'Classify the reply.',
  criteria: { yes: 'Yes.', no: 'No.' },
};

// NO NETWORK, red or green: every secret is in this machine's env, so the global fetch
// is replaced (never spied through) and the gateway keys are stubbed.
let globalHosts: string[];
beforeEach(() => {
  globalHosts = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL) => {
      globalHosts.push(new URL(String(url)).host);
      return Response.json(JEV_BODY);
    }),
  );
  vi.stubEnv('AI_GATEWAY_API_KEY', 'test-key-no-network');
  vi.stubEnv('VERCEL_KEY', '');
  vi.stubEnv('JEV_KEY', '');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function parentTextClearance(): Promise<NonGoogleClearance> {
  const decision = await clearForNonAnthropic({ kind: 'parent_text' }, 'jev test');
  if (!('cleared' in decision)) throw new Error('expected a clearance for parent text');
  return decision.cleared;
}

describe('evaluateJevChoice', () => {
  it('returns a validated choice and provider confidence', async () => {
    const fetch = vi.fn(async () => Response.json(JEV_BODY));

    await expect(
      evaluateJevChoice(ARGS, await parentTextClearance(), { apiKey: 'test', fetch }),
    ).resolves.toEqual({
      choice: 'yes',
      probabilities: { yes: 0.9, no: 0.1 },
      confidence: 0.8,
      usage: { inputTokens: 12, outputTokens: 1 },
    });
  });

  it('refuses a forged clearance before any request leaves', async () => {
    const injected = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json(JEV_BODY),
    );
    const forged = { basis: 'parent_text' } as unknown as NonGoogleClearance;

    await expect(
      evaluateJevChoice(ARGS, forged, { apiKey: 'test-key-no-network', fetch: injected }),
    ).rejects.toThrow(ProviderClearanceError);
    expect(globalHosts).toEqual([]);
    expect(injected).not.toHaveBeenCalled();
  });

  it('positive control: a minted clearance reaches the injected transport once', async () => {
    const injected = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json(JEV_BODY),
    );

    await evaluateJevChoice(ARGS, await parentTextClearance(), {
      apiKey: 'test-key-no-network',
      fetch: injected,
    });
    expect(injected).toHaveBeenCalledTimes(1);
    expect(injected.mock.calls[0]?.[0]).toBe('https://ai-gateway.vercel.sh/v1/evaluate');
    expect(globalHosts).toEqual([]);
  });
});

describe('meetsJevConfidence', () => {
  const result = (yes: number, no: number) => ({
    choice: 'yes' as const,
    probabilities: { yes, no },
    confidence: null,
    usage: { inputTokens: 0, outputTokens: 0 },
  });

  it('requires both a high selected probability and a clear margin', () => {
    expect(meetsJevConfidence(result(0.9, 0.1))).toBe(true);
    expect(meetsJevConfidence(result(0.75, 0.25))).toBe(false);
    expect(meetsJevConfidence(result(0.8, 0.3))).toBe(true);
  });
});
