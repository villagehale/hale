import { describe, expect, it, vi } from 'vitest';
import { fakeCheckInIntentReader } from './fakes';
import { type CheckInIntentInput, type CheckInIntentReader, readCheckInIntent } from './intent';

/**
 * The plumbing around one reading: no reader, a reader that fails, a reader that
 * recovers on the retry, and what #ops is told. The reading itself is a fake here;
 * the real model's readings are the cached eval's job (rule #8).
 */

const INPUT: CheckInIntentInput = {
  reply: 'no thanks',
  language: 'en',
  questionStanding: true,
  cadence: 'daily',
};

function pager() {
  const texts: string[] = [];
  return {
    texts,
    page: async (text: string) => {
      texts.push(text);
    },
  };
}

describe('readCheckInIntent', () => {
  it('settles a good reading and pages nobody', async () => {
    const reader = fakeCheckInIntentReader();
    const ops = pager();
    const result = await readCheckInIntent(reader, INPUT, { page: ops.page });
    expect(result).toEqual({ intent: 'cadence_off', interpretation: 'fake', failure: null });
    expect(reader.calls).toEqual([INPUT]);
    expect(ops.texts).toEqual([]);
  });

  it('names a missing reader, pages #ops with the skill and the reason, and reads nothing itself', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const ops = pager();
    const result = await readCheckInIntent(undefined, INPUT, { page: ops.page });
    expect(result).toEqual({
      intent: 'other',
      interpretation: 'reader_unavailable',
      failure: 'reader_unavailable',
    });
    expect(ops.texts).toEqual([
      'check-in intent unread skill=checkin-intent reason=reader_unavailable',
    ]);
    // Rule #1: nothing the parent wrote reaches #ops.
    expect(ops.texts.join(' ')).not.toContain('no thanks');
    vi.restoreAllMocks();
  });

  it('tries twice on a failing model, then names model_failed and pages once', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const reader = fakeCheckInIntentReader({ fail: true });
    const ops = pager();
    const result = await readCheckInIntent(reader, INPUT, { page: ops.page });
    expect(result).toEqual({
      intent: 'other',
      interpretation: 'model_failed',
      failure: 'model_failed',
    });
    expect(reader.calls).toHaveLength(2);
    expect(ops.texts).toEqual(['check-in intent unread skill=checkin-intent reason=model_failed']);
    vi.restoreAllMocks();
  });

  it('takes the retry when the first attempt throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let attempts = 0;
    const flaky: CheckInIntentReader = {
      async read(input) {
        attempts += 1;
        if (attempts === 1) throw new Error('timeout');
        return {
          intent: 'day_note',
          verbatim: input.reply,
          rationale: 'about the day',
          confidence: 0.8,
        };
      },
    };
    const ops = pager();
    const result = await readCheckInIntent(flaky, INPUT, { page: ops.page });
    expect(result).toEqual({ intent: 'day_note', interpretation: 'about the day', failure: null });
    expect(attempts).toBe(2);
    expect(ops.texts).toEqual([]);
    vi.restoreAllMocks();
  });

  it('runs the guards on what the model returns: a paraphrased echo is not a reading', async () => {
    const reader = fakeCheckInIntentReader({
      answer: (input) => ({
        intent: 'cadence_off',
        verbatim: input.reply.toUpperCase(),
        rationale: 'fake',
        confidence: 0.99,
      }),
    });
    const result = await readCheckInIntent(reader, INPUT);
    expect(result.intent).toBe('other');
    expect(result.failure).toBeNull();
  });

  it('survives a pager that throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await readCheckInIntent(undefined, INPUT, {
      page: async () => {
        throw new Error('slack down');
      },
    });
    expect(result.failure).toBe('reader_unavailable');
    vi.restoreAllMocks();
  });
});
