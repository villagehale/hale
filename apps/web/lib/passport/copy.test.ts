import type { AgentClient } from '@hale/agent';
import { describe, expect, it } from 'vitest';
import { composePassportLine, interpretPassportReply, lineViolations } from './copy';
import type { PassportLineFacts } from './copy';

const facts: PassportLineFacts = {
  job: 'confirm',
  acknowledgment: null,
  language: 'en',
  childName: 'Mia',
  activity: 'Karate',
  seasonLabel: 'Fall 2026',
  sourceLabel: 'Seen in your Gmail receipt',
  nextStep: null,
};

describe('passport copy', () => {
  it('rejects a line that says Hale enrolled the child', () => {
    expect(lineViolations('I booked karate for Mia.', null, facts).length).toBeGreaterThan(0);
    expect(lineViolations('Hale enrolled Mia in karate.', null, facts).length).toBeGreaterThan(0);
    expect(lineViolations('I saw a karate receipt for the fall session.', null, facts)).toEqual([]);
  });

  it('does not suggest an activity the child already has', () => {
    const adjacent: PassportLineFacts = {
      ...facts,
      nextStep: { mode: 'adjacent', forbiddenActivityKeys: ['soccer'] },
    };
    expect(
      lineViolations('Want me to watch for swimming?', 'Soccer', adjacent).length,
    ).toBeGreaterThan(0);
    expect(
      lineViolations('Want me to watch for swimming?', 'Karate', adjacent).length,
    ).toBeGreaterThan(0);
    expect(lineViolations('Want me to watch for swimming?', 'Swimming', adjacent)).toEqual([]);
  });

  it('does not treat a bare yes as a confirm when there is no model', async () => {
    const intent = await interpretPassportReply(null, 'yes');
    expect(intent.intent).toBe('none');
    const line = await composePassportLine(null, facts);
    expect(line).toEqual({ ok: false, reason: 'copy_unavailable' });
  });

  it('drops a model line that claims a booking instead of sending a fallback', async () => {
    const client = {
      messages: {
        create: async () => ({
          stop_reason: 'end_turn',
          content: [
            {
              type: 'tool_use',
              id: 'tool',
              name: 'passport_line',
              input: { text: 'I enrolled Mia in karate.', suggestedActivity: null },
            },
          ],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      },
    } as unknown as AgentClient;
    const line = await composePassportLine(client, facts);
    expect(line.ok).toBe(false);
    if (!line.ok) expect(line.reason).toBe('copy_unavailable');
  });
});
