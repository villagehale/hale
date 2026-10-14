import { describe, expect, it } from 'vitest';
import { spendGate } from '../run-autonomy-notice-eval.mjs';
import { makeCost, totalUsd } from './harness.mjs';

/**
 * A call cut off at max_tokens is thrown away by the caller before noteUsage.
 * The pre-call check had already reserved this call's ceiling. If that
 * reservation is not booked, the next call can cross the cap.
 */
describe('the spend gate books a truncated call', () => {
  const params = {
    model: 'claude-haiku-4-5',
    max_tokens: 440,
    system: 'score it',
    tools: [],
    messages: [{ role: 'user', content: 'hello' }],
  };

  it('books the projected ceiling when the reply stops at max_tokens, before the caller throws', async () => {
    const cost = makeCost();
    const gated = spendGate(
      () => ({
        messages: {
          create: async () => ({
            stop_reason: 'max_tokens',
            content: [],
            usage: { input_tokens: 10, output_tokens: 440 },
          }),
        },
      }),
      cost,
      1,
    );

    const response = await gated().messages.create(params);
    expect(response.capBooked).toBe(true);
    expect(cost.liveCalls).toBe(1);
    const spent = totalUsd(cost);
    expect(spent).toBeGreaterThan(0);

    const next = spendGate(
      () => ({
        messages: {
          create: async () => {
            throw new Error('should not send');
          },
        },
      }),
      cost,
      spent,
    );
    await expect(next().messages.create(params)).rejects.toMatchObject({ code: 'SPEND_CAP' });
  });

  it('leaves a finished reply for the caller to book at actual usage', async () => {
    const cost = makeCost();
    const gated = spendGate(
      () => ({
        messages: {
          create: async () => ({
            stop_reason: 'tool_use',
            content: [],
            usage: { input_tokens: 10, output_tokens: 20 },
          }),
        },
      }),
      cost,
      1,
    );

    const response = await gated().messages.create(params);
    expect(response.capBooked).toBeUndefined();
    expect(cost.liveCalls).toBe(0);
    expect(totalUsd(cost)).toBe(0);
  });
});
