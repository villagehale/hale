import type { AgentClient } from '@hale/agent';
import { describe, expect, it, vi } from 'vitest';
import { structuredReply } from '~/lib/testing/structured-reply';
import { burstReaderUserMessage, createBurstReader, partitionProblems } from './burst-reader';

/**
 * Whether texts belong together is the model's call (inbound-burst-read, cached in
 * run-inbound-burst-eval.mjs). Code checks only the SHAPE of its answer: every text
 * placed exactly once, none invented, no empty group.
 */
describe('partitionProblems', () => {
  const refs = ['m1', 'm2', 'm3'];

  it('accepts a partition that places every text exactly once', () => {
    expect(partitionProblems(refs, [['m1', 'm3'], ['m2']])).toEqual([]);
    expect(partitionProblems(refs, [['m1', 'm2', 'm3']])).toEqual([]);
    expect(partitionProblems(refs, [['m1'], ['m2'], ['m3']])).toEqual([]);
  });

  it('names a text no group placed', () => {
    expect(partitionProblems(refs, [['m1', 'm2']])).toEqual(['ref_missing']);
  });

  it('names a text placed twice', () => {
    expect(
      partitionProblems(refs, [
        ['m1', 'm2'],
        ['m2', 'm3'],
      ]),
    ).toEqual(['ref_repeated']);
  });

  it('names a ref that is not one of the texts', () => {
    expect(partitionProblems(refs, [['m1', 'm2', 'm3', 'm4']])).toEqual(['ref_unknown']);
  });

  it('names an empty group', () => {
    expect(partitionProblems(refs, [['m1', 'm2', 'm3'], []])).toEqual(['empty_group']);
  });

  it('names every problem at once, so one re-ask can fix them all', () => {
    expect(partitionProblems(refs, [['m1', 'm1', 'm9'], []])).toEqual([
      'ref_missing',
      'ref_repeated',
      'ref_unknown',
      'empty_group',
    ]);
  });
});

describe('burstReaderUserMessage', () => {
  const input = {
    messages: [
      { ref: 'm1', text: 'first', attachments: [] },
      { ref: 'm2', text: '', attachments: ['image' as const] },
    ],
    previousHaleLine: null,
  };

  it('carries the texts, their attachment kinds and Hale’s last line, and nothing else', () => {
    expect(JSON.parse(burstReaderUserMessage(input))).toEqual({
      previousHaleLine: null,
      messages: [
        { ref: 'm1', text: 'first', attachments: [] },
        { ref: 'm2', text: '', attachments: ['image'] },
      ],
    });
  });

  it('adds the refused grouping and its problems only on the re-ask', () => {
    const asked = JSON.parse(
      burstReaderUserMessage(input, [{ groups: [['m1']], problems: ['ref_missing'] }]),
    );
    expect(asked.rejected).toEqual([{ groups: [['m1']], problems: ['ref_missing'] }]);
  });
});

/** What the model's answer was is scripted; what the code does with it is asserted. */
function clientAnswering(groupings: string[][][], seen: unknown[] = []): () => AgentClient {
  const queue = [...groupings];
  return () =>
    ({
      messages: {
        create: vi.fn(async (request: unknown) => {
          seen.push(request);
          return structuredReply(request, 'group_texts', {
            reasoning: 'read',
            groups: queue.shift() ?? [],
          });
        }),
      },
    }) as unknown as AgentClient;
}

describe('createBurstReader', () => {
  const two = {
    messages: [
      { ref: 'm1', text: 'a', attachments: [] },
      { ref: 'm2', text: 'b', attachments: [] },
    ],
    previousHaleLine: null,
  };

  it('returns a grouping that places every text once', async () => {
    const reading = await createBurstReader(clientAnswering([[['m1', 'm2']]])).read(two);
    expect(reading).toEqual({ status: 'read', groups: [['m1', 'm2']] });
  });

  it('hands a refused grouping back with its problems, and names it when it never passes', async () => {
    const seen: unknown[] = [];
    const quiet = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const reading = await createBurstReader(clientAnswering([[['m1']], [['m1', 'm9']]], seen)).read(
      two,
    );
    expect(reading).toEqual({ status: 'unavailable', reason: 'invalid_partition' });
    expect(seen).toHaveLength(2);
    const second = seen[1] as { messages: { content: string }[] };
    expect(JSON.parse(second.messages[0]?.content ?? '{}').rejected).toEqual([
      { groups: [['m1']], problems: ['ref_missing'] },
    ]);
    quiet.mockRestore();
  });

  it('takes the corrected grouping on the re-ask', async () => {
    const reading = await createBurstReader(clientAnswering([[['m1']], [['m1'], ['m2']]])).read(
      two,
    );
    expect(reading).toEqual({ status: 'read', groups: [['m1'], ['m2']] });
  });

  it('names a missing client rather than throwing', async () => {
    const quiet = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const reading = await createBurstReader(() => {
      throw new Error('no key');
    }).read(two);
    expect(reading).toEqual({ status: 'unavailable', reason: 'client_unavailable' });
    quiet.mockRestore();
  });
});
