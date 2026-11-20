import { type AgentClient, SONNET_MODEL } from '@hale/agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createIntakeExtractor } from './extract';

function response() {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          children: [{ name: 'Mia', age_months: 48, age_precision: 'years' }],
          postal_code: 'M5V 2T6',
          confidence: 0.9,
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
  };
}

const INPUT = {
  message: 'Mia is four, M5V 2T6',
  alreadyKnown: { children: [], postalCode: null },
};

describe('createIntakeExtractor rollout', () => {
  beforeEach(() => vi.stubEnv('HALE_INTAKE_EXTRACT_MODEL_MODE', ''));
  afterEach(() => vi.unstubAllEnvs());

  it.each([undefined, '', ' \t\n ', 'invalid', 'shadow', 'current'])(
    'keeps Sonnet 5 for model mode %j',
    async (raw) => {
      vi.stubEnv('HALE_INTAKE_EXTRACT_MODEL_MODE', raw);
      const create = vi.fn(async () => response());
      const result = await createIntakeExtractor({
        messages: { create },
      } as unknown as AgentClient).extract(INPUT);

      expect(result.children).toHaveLength(1);
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          model: SONNET_MODEL,
        }),
      );
    },
  );

  it('falls back to Sonnet 5 when the candidate fails', async () => {
    const create = vi.fn().mockRejectedValueOnce(new Error('candidate unavailable'));
    create.mockResolvedValueOnce(response());
    const client = { messages: { create } } as unknown as AgentClient;

    await createIntakeExtractor(client, { modelMode: 'candidate' }).extract(INPUT);

    expect(create).toHaveBeenNthCalledWith(2, expect.objectContaining({ model: SONNET_MODEL }));
  });

  it('keeps a named birth date as the civil day, with no timezone conversion (VIL-531)', async () => {
    const create = vi.fn(async () => ({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            children: [
              {
                name: 'Lin',
                age_months: null,
                age_precision: null,
                date_of_birth: '2016-05-01T00:00:00.000Z',
              },
            ],
            postal_code: null,
            confidence: 0.9,
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
    }));
    const result = await createIntakeExtractor({
      messages: { create },
    } as unknown as AgentClient).extract({
      message: 'Lin was born May 1, 2016',
      alreadyKnown: { children: [], postalCode: null },
    });

    expect(result.children).toEqual([
      { name: 'Lin', ageMonths: null, agePrecision: null, dateOfBirth: '2016-05-01' },
    ]);
  });

  it('uses Sonnet 5 when current mode is explicit', async () => {
    const create = vi.fn(async () => response());
    const client = { messages: { create } } as unknown as AgentClient;

    await createIntakeExtractor(client, { modelMode: 'current' }).extract(INPUT);

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ model: SONNET_MODEL }));
  });
});
