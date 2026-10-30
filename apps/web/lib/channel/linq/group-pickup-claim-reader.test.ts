import type { AgentClient } from '@hale/agent';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GROUP_PICKUP_CLAIM_MAX_TOKENS,
  type GroupPickupClaimReadInput,
  groupPickupClaimUserMessage,
} from './group-pickup-claim';
import { createGroupPickupClaimReader } from './group-pickup-claim-reader';

/**
 * VIL-444 (T24) — the claim reader's failure path. The client here only fails: what a
 * reading says is graded by the judged eval against real recorded responses (rule #8).
 */

const INPUT: GroupPickupClaimReadInput = {
  text: "I'll grab Leo from daycare",
  senderName: 'Sam',
  pickups: [
    {
      ref: 'p1',
      title: 'Leo daycare pickup',
      day: 'Friday, September 25',
      start: '15:00',
      end: '15:30',
      has: 'Barton',
      inAlert: true,
      askedOf: null,
    },
  ],
  recent: [],
};

function unreachable(): { client: AgentClient; requests: unknown[] } {
  const requests: unknown[] = [];
  const fail = async (request: unknown) => {
    requests.push(request);
    throw Object.assign(new Error('connection refused'), { name: 'APIConnectionError' });
  };
  return {
    client: { messages: { create: fail, stream: fail } } as unknown as AgentClient,
    requests,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('VIL-444 group pickup claim reader', () => {
  it('tries twice, then reads nothing and logs that nothing was stored', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client, requests } = unreachable();

    expect(await createGroupPickupClaimReader(() => client).read(INPUT)).toBeNull();

    expect(requests).toHaveLength(2);
    expect(warn).toHaveBeenCalledWith(
      { attempt: 1, err: 'APIConnectionError' },
      'group pickup claim: read failed',
    );
    expect(warn).toHaveBeenCalledWith(
      { attempt: 2, err: 'APIConnectionError' },
      'group pickup claim: read failed',
    );
    expect(error).toHaveBeenCalledWith(
      { outcome: 'group_pickup_claim_unread' },
      'group pickup claim: nothing stored',
    );
    expect(JSON.stringify([...warn.mock.calls, ...error.mock.calls])).not.toContain('daycare');
  });

  it('asks with the claim skill, the offers it was given, and its own budget', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client, requests } = unreachable();

    await createGroupPickupClaimReader(() => client).read(INPUT);

    const request = requests[0] as {
      max_tokens: number;
      system: Array<{ text: string }>;
      messages: Array<{ role: string; content: string }>;
    };
    expect(request.max_tokens).toBe(GROUP_PICKUP_CLAIM_MAX_TOKENS);
    expect(request.system[0]?.text).toContain('# Did the sender take a pickup?');
    expect(request.messages).toEqual([
      { role: 'user', content: groupPickupClaimUserMessage(INPUT) },
    ]);
  });
});
