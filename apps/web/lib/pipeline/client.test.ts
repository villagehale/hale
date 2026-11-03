import type Anthropic from '@anthropic-ai/sdk';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CRON_SWEEP_CLIENT_OPTIONS,
  HOT_SMS_CLIENT_OPTIONS,
  budgetedAiGateway,
  pipelineClient,
} from './client';
import {
  type NonGoogleClearance,
  ProviderClearanceError,
  clearForNonAnthropic,
} from './provider-clearance';

/**
 * The SMS hot-path budget, read off the constructed client rather than off the constant,
 * because the constant being right proves nothing if the factory does not apply it.
 *
 * A texted turn that times out is requeued, so this budget can afford to be generous —
 * a late real reply beats a fast wrong one. The spoken-turn client that used to sit
 * beside it is gone with ConversationRelay.
 */
describe('the anthropic client budgets', () => {
  beforeAll(() => {
    process.env.ANTHROPIC_API_KEY ??= 'test-key-not-used-no-request-is-made';
  });

  const asClient = (c: unknown) => c as Anthropic;

  it('applies the SMS budget, including the one retry a queued turn can afford', () => {
    const sms = asClient(pipelineClient());
    expect(sms.timeout).toBe(HOT_SMS_CLIENT_OPTIONS.timeout);
    expect(sms.maxRetries).toBe(HOT_SMS_CLIENT_OPTIONS.maxRetries);
  });

  it('leaves the reviewer its measured headroom — a draft must not be lost to the clock', () => {
    // The reviewer inside a propose_* draft runs on the pipeline client. Measured
    // 2026-08-20: 6.5s and 6.9s per request against claude-sonnet-5. Rule #3 makes it
    // non-optional, so its budget has to clear that with room.
    expect(asClient(pipelineClient()).timeout).toBeGreaterThan(14_000);
  });

  it('hands back the same cached instance', () => {
    expect(pipelineClient()).toBe(pipelineClient());
  });
});

/**
 * VIL-556: the gateway client is a non-Anthropic transport, so it is built only for a
 * minted NonGoogleClearance. No request is made here: `.messages.create` is never called,
 * and the global fetch is replaced so a regression cannot reach the network.
 */
describe('budgetedAiGateway requires a clearance', () => {
  let globalHosts: string[];
  beforeEach(() => {
    globalHosts = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        globalHosts.push(new URL(String(url)).host);
        return Response.json({});
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

  it('refuses to build a client for a forged clearance', () => {
    const forged = { basis: 'family_without_google' } as unknown as NonGoogleClearance;
    expect(() => budgetedAiGateway(CRON_SWEEP_CLIENT_OPTIONS, forged)).toThrow(
      ProviderClearanceError,
    );
    expect(globalHosts).toEqual([]);
  });

  it('positive control: a minted clearance builds a client and sends nothing', async () => {
    const decision = await clearForNonAnthropic({ kind: 'parent_text' }, 'client test');
    if (!('cleared' in decision)) throw new Error('expected a clearance for parent text');
    const gateway = budgetedAiGateway(CRON_SWEEP_CLIENT_OPTIONS, decision.cleared) as Anthropic;
    expect(gateway.timeout).toBe(CRON_SWEEP_CLIENT_OPTIONS.timeout);
    expect(globalHosts).toEqual([]);
  });
});
