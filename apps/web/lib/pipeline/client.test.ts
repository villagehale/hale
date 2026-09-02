import type Anthropic from '@anthropic-ai/sdk';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  HOT_SMS_CLIENT_OPTIONS,
  VOICE_CLIENT_OPTIONS,
  pipelineClient,
  voiceClient,
} from './client';

/**
 * The two hot-path budgets, and the relationship between them.
 *
 * Both numbers are a claim about what happens when the model is slow, and the claims are
 * OPPOSITE. A texted turn that times out is requeued, so its budget can afford to be
 * generous — a late real reply beats a fast wrong one. A SPOKEN turn has no queue: every
 * second past the timeout is a parent listening to silence, and the retry that helps SMS
 * simply doubles it. Voice v2 shipped inheriting the SMS budget and a stalled first
 * request cost a real caller 71 seconds of dead air before the fixed apology.
 *
 * These are read as `.timeout` / `.maxRetries` off the constructed client rather than off
 * the constants, because the constant being right proves nothing if the factory does not
 * apply it.
 */
describe('the anthropic client budgets', () => {
  beforeAll(() => {
    process.env.ANTHROPIC_API_KEY ??= 'test-key-not-used-no-request-is-made';
  });

  const asClient = (c: unknown) => c as Anthropic;

  it('gives a spoken turn a strictly tighter budget than the queue-backed texting one', () => {
    const voice = asClient(voiceClient());
    const sms = asClient(pipelineClient());

    expect(voice.timeout).toBe(VOICE_CLIENT_OPTIONS.timeout);
    expect(voice.maxRetries).toBe(0);
    expect(sms.timeout).toBe(HOT_SMS_CLIENT_OPTIONS.timeout);

    // What a caller can actually be made to sit through: every attempt, not just one.
    const worstCase = (c: Anthropic) => c.timeout * (c.maxRetries + 1);
    expect(worstCase(voice)).toBeLessThan(worstCase(sms));
    expect(worstCase(voice)).toBeLessThanOrEqual(10_000);
  });

  it('leaves the reviewer its measured headroom — a spoken draft must not be lost to the clock', () => {
    // The reviewer inside a propose_* draft runs on the pipeline client, after the ack
    // line has been spoken. Measured 2026-08-20: 6.5s and 6.9s per request against
    // claude-sonnet-5. Rule #3 makes it non-optional, so its budget has to clear that
    // with room, and this is the assertion that fails if someone "unifies" the two.
    expect(asClient(pipelineClient()).timeout).toBeGreaterThan(14_000);
  });

  it('hands back the same cached instance, and a different one per budget', () => {
    expect(voiceClient()).toBe(voiceClient());
    expect(voiceClient()).not.toBe(pipelineClient());
  });
});
