import type { AgentClient } from '@hale/agent';
import { describe, expect, it } from 'vitest';
import { dutyParseFromExtraction, extractDutyReply } from './extract';
import type { DutyParseInput } from './parse';

/**
 * Mechanics only. Whether a reply "sounds like" pickup is the eval set's job
 * for the rules, and a live model is not what this file grades.
 */

const INPUT: DutyParseInput = {
  text: 'Grandma is picking up',
  speakerUserId: 'a',
  parents: [
    { userId: 'a', name: 'Barton' },
    { userId: 'b', name: 'Sam' },
  ],
  childNames: ['Maya'],
  eventTitle: 'Maya swim',
};

function scriptedClient(input: Record<string, unknown>): AgentClient {
  return {
    messages: {
      async create() {
        return {
          content: [{ type: 'tool_use', name: 'coparent_duty', input }],
          usage: { input_tokens: 10, output_tokens: 5 },
          stop_reason: 'tool_use',
        };
      },
    },
  } as unknown as AgentClient;
}

describe('extractDutyReply', () => {
  it('drops a name the reply does not contain and refuses confidence under 0.7', () => {
    const invented = dutyParseFromExtraction(INPUT, {
      question: false,
      confidence: 0.9,
      slots: [{ role: 'pickup', claim: 'named', name: 'Grandpa', confidence: 0.9 }],
    });
    expect(invented.write).toBe(false);
    expect(invented.slots).toEqual([]);

    const low = dutyParseFromExtraction(INPUT, {
      question: false,
      confidence: 0.4,
      slots: [{ role: 'pickup', claim: 'named', name: 'Grandma', confidence: 0.4 }],
    });
    expect(low.write).toBe(false);
    expect(low.slots[0]?.confidence).toBeLessThan(0.7);
  });

  it('a question from the model writes nothing', () => {
    const parsed = dutyParseFromExtraction(
      { ...INPUT, text: 'wait who is going' },
      { question: true, confidence: 0.9, slots: [] },
    );
    expect(parsed.question).toBe(true);
    expect(parsed.write).toBe(false);
  });

  it('reads a corroborated slot through the forced tool', async () => {
    const parsed = await extractDutyReply(
      INPUT,
      scriptedClient({
        question: false,
        confidence: 0.85,
        slots: [{ role: 'pickup', claim: 'named', name: 'Grandma', confidence: 0.85 }],
      }),
    );
    expect(parsed.write).toBe(true);
    expect(parsed.slots[0]).toMatchObject({ role: 'pickup', claim: 'named', name: 'Grandma' });
    expect(parsed.llm).toBe('used');
  });
});
