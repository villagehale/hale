import type Anthropic from '@anthropic-ai/sdk';
import { DEEPSEEK_MODEL, SONNET_MODEL } from '@hale/agent';
import { describe, expect, it, vi } from 'vitest';
import { runDrafter } from './drafter.js';

const input = {
  familyId: '11111111-1111-4111-8111-111111111111',
  event: {
    eventId: '22222222-2222-4222-8222-222222222222',
    eventType: 'clinic_reply',
    payload: { from: 'clinic@example.com' },
  },
  actionType: 'reply_to_email' as const,
};

function client(body: string): Pick<Anthropic, 'messages'> {
  return {
    messages: {
      create: vi.fn(async (request: Anthropic.MessageCreateParamsNonStreaming) => ({
        id: 'msg_test',
        type: 'message' as const,
        role: 'assistant' as const,
        model: request.model,
        stop_reason: 'tool_use' as const,
        stop_sequence: null,
        content: [
          {
            type: 'tool_use' as const,
            id: 'tool_1',
            name: 'draft_action',
            input: {
              payload: { to: 'clinic@example.com', subject: 'Re:', body },
              confidence: 0.9,
              rationale: 'fixture',
              recipient_visibility: 'public',
            },
          },
        ],
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          cache_creation_input_tokens: null,
          cache_read_input_tokens: null,
          server_tool_use: null,
        },
      })),
    },
  } as unknown as Pick<Anthropic, 'messages'>;
}

describe('runDrafter — action-drafter rollout', () => {
  it('uses Gateway DeepSeek only when candidate mode is explicit', async () => {
    const currentClient = client('current');
    const candidateClient = client('candidate');

    const result = await runDrafter(input, {
      currentClient,
      candidateClient,
      modelMode: 'candidate',
    });

    expect(currentClient.messages.create).not.toHaveBeenCalled();
    const request = (candidateClient.messages.create as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0];
    expect(request).toMatchObject({
      model: DEEPSEEK_MODEL,
      thinking: { type: 'disabled' },
      providerOptions: { gateway: { zeroDataRetention: true } },
    });
    expect(request).not.toHaveProperty('output_config');
    expect(result.draft.payload.body).toBe('candidate');
    expect(result.runMetrics.modelUsed).toBe(DEEPSEEK_MODEL);
  });

  it('falls back to Sonnet when the candidate request fails', async () => {
    const currentClient = client('fallback');
    const candidateClient = client('candidate');
    (candidateClient.messages.create as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('gateway unavailable'),
    );

    const result = await runDrafter(input, {
      currentClient,
      candidateClient,
      modelMode: 'candidate',
    });

    expect(candidateClient.messages.create).toHaveBeenCalledTimes(1);
    expect(currentClient.messages.create).toHaveBeenCalledTimes(1);
    expect(result.draft.payload.body).toBe('fallback');
    expect(result.runMetrics.modelUsed).toBe(SONNET_MODEL);
  });
});
