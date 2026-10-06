import { type AgentClient, SONNET5_MODEL } from '@hale/agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { classifyEvent } from './classify';

const OUTPUT = {
  event_type: 'school_communication',
  confidence: 0.9,
  rationale: 'School update',
  payload: {},
  suggested_action: { kind: 'surface_only' },
  teen_content: false,
  concerns_child_id: null,
};

function response() {
  return {
    content: [{ type: 'tool_use', id: 'tool_1', name: 'classification', input: OUTPUT }],
    stop_reason: 'tool_use',
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
    },
  };
}

describe('classifyEvent rollout', () => {
  beforeEach(() => vi.stubEnv('HALE_CLASSIFY_EVENT_MODEL_MODE', ''));
  afterEach(() => vi.unstubAllEnvs());

  it.each([undefined, '', ' \t\n ', 'invalid', 'shadow', 'current'])(
    'keeps Sonnet 5 for model mode %j',
    async (raw) => {
      vi.stubEnv('HALE_CLASSIFY_EVENT_MODEL_MODE', raw);
      const create = vi.fn(async () => response());
      const result = await classifyEvent(
        {
          source: 'email',
          payload: { subject: 'School update' },
          childNames: [],
        },
        { messages: { create } } as unknown as AgentClient,
      );

      expect(result.model).toBe(SONNET5_MODEL);
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          model: SONNET5_MODEL,
        }),
      );
    },
  );

  it('falls back to Sonnet 5 when the candidate fails', async () => {
    const create = vi.fn().mockRejectedValueOnce(new Error('candidate unavailable'));
    create.mockResolvedValueOnce(response());

    const result = await classifyEvent(
      {
        source: 'email',
        payload: { subject: 'School update' },
        childNames: [],
      },
      { messages: { create } } as unknown as AgentClient,
      { modelMode: 'candidate' },
    );

    expect(result.model).toBe(SONNET5_MODEL);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('uses Sonnet 5 when current mode is explicit', async () => {
    const create = vi.fn(async () => response());
    const result = await classifyEvent(
      {
        source: 'email',
        payload: { subject: 'School update' },
        childNames: [],
      },
      { messages: { create } } as unknown as AgentClient,
      { modelMode: 'current' },
    );

    expect(result.model).toBe(SONNET5_MODEL);
    expect(create).toHaveBeenCalledTimes(1);
  });
});
