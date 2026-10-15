import type { AgentClient } from '@hale/agent';
import { describe, expect, it, vi } from 'vitest';
import { createMomentReply } from './moment-reply';

function clientReturning(reply: string | Error, times = 1): () => AgentClient {
  let calls = 0;
  return () =>
    ({
      messages: {
        async create() {
          calls += 1;
          const step = calls <= times ? reply : 'later';
          if (step instanceof Error) throw step;
          return {
            content: [{ type: 'text', text: JSON.stringify({ reply: step }) }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 1, output_tokens: 1 },
          };
        },
      },
    }) as unknown as AgentClient;
}

describe('moment reply', () => {
  it('retries a thrown call and sends the reply once it is written', async () => {
    let calls = 0;
    const client = () =>
      ({
        messages: {
          async create() {
            calls += 1;
            if (calls === 1) throw new Error('upstream 529');
            return {
              content: [
                { type: 'text', text: JSON.stringify({ reply: 'Get help where you are.' }) },
              ],
              stop_reason: 'end_turn',
              usage: { input_tokens: 1, output_tokens: 1 },
            };
          },
        },
      }) as unknown as AgentClient;

    await expect(createMomentReply(client).write('help', 'emergency')).resolves.toEqual({
      status: 'written',
      reply: 'Get help where you are.',
    });
    expect(calls).toBe(2);
  });

  it('names model_failed when both attempts throw, and sends nothing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const written = await createMomentReply(clientReturning(new Error('upstream 529'), 2)).write(
      'help',
      'emergency',
    );
    expect(written).toEqual({ status: 'unwritten', reason: 'model_failed' });
  });

  it('sends a reply that names a link or the app; only an empty body is refused', async () => {
    const linked = await createMomentReply(
      clientReturning('Look at https://example.com if you can.'),
    ).write('help', 'child_health');
    expect(linked).toEqual({
      status: 'written',
      reply: 'Look at https://example.com if you can.',
    });

    vi.spyOn(console, 'error').mockImplementation(() => {});
    const empty = await createMomentReply(clientReturning('   ', 2)).write(
      'help',
      'could_not_answer',
    );
    expect(empty).toEqual({ status: 'unwritten', reason: 'unsendable' });
  });
});
