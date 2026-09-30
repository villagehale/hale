import type Anthropic from '@anthropic-ai/sdk';
import { beforeAll, describe, expect, it } from 'vitest';
import { HOT_SMS_CLIENT_OPTIONS, pipelineClient } from './client';

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
