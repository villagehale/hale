import { type AgentClient, SONNET5_MODEL, SONNET55_MODEL } from '@hale/agent';
import { describe, expect, it, vi } from 'vitest';
import { createIntakeExtractor } from './extract';

function response() {
  return {
    content: [
      {
        type: 'tool_use',
        id: 'tool_1',
        name: 'intake',
        input: {
          children: [{ name: 'Mia', age_months: 48, age_precision: 'years' }],
          postal_code: 'M5V 2T6',
          confidence: 0.9,
        },
      },
    ],
    stop_reason: 'tool_use',
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
    },
  };
}

const INPUT = {
  message: 'Mia is four, M5V 2T6',
  alreadyKnown: { children: [], postalCode: null },
};

describe('createIntakeExtractor rollout', () => {
  it('uses Sonnet 5.5 by default', async () => {
    const create = vi.fn(async () => response());
    const result = await createIntakeExtractor({
      messages: { create },
    } as unknown as AgentClient).extract(INPUT);

    expect(result.children).toHaveLength(1);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: SONNET55_MODEL,
        tool_choice: { type: 'auto' },
      }),
    );
  });

  it('falls back to Sonnet 5 when the candidate fails', async () => {
    const create = vi.fn().mockRejectedValueOnce(new Error('candidate unavailable'));
    create.mockResolvedValueOnce(response());
    const client = { messages: { create } } as unknown as AgentClient;

    await createIntakeExtractor(client, { modelMode: 'candidate' }).extract(INPUT);

    expect(create).toHaveBeenNthCalledWith(2, expect.objectContaining({ model: SONNET5_MODEL }));
  });

  it('uses Sonnet 5 when current mode is explicit', async () => {
    const create = vi.fn(async () => response());
    const client = { messages: { create } } as unknown as AgentClient;

    await createIntakeExtractor(client, { modelMode: 'current' }).extract(INPUT);

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ model: SONNET5_MODEL }));
  });
});
