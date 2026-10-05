import { describe, expect, it, vi } from 'vitest';
import { fakeRequestIntentReader } from './fakes';
import {
  type RequestIntentInput,
  type RequestIntentReader,
  readRequestIntent,
} from './request-intent';

/**
 * The plumbing around one reading: no reader, a reader that fails, a reader that
 * recovers on the retry, and what #ops is told. The reading itself is a fake here;
 * the real model's readings are the cached eval's job (rule #8).
 */

const INPUT: RequestIntentInput = {
  message: 'connect my gmail please',
  language: 'en',
  setting: 'own_thread',
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

describe('readRequestIntent', () => {
  it('settles a good reading and pages nobody', async () => {
    const reader = fakeRequestIntentReader();
    const ops = pager();
    const result = await readRequestIntent(reader, INPUT, { page: ops.page });
    expect(result).toEqual({ intent: 'connect_gmail', interpretation: 'fake', failure: null });
    expect(reader.calls).toEqual([INPUT]);
    expect(ops.texts).toEqual([]);
  });

  it('names a missing reader, pages #ops with the skill and the reason, and reads nothing itself', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const ops = pager();
    const result = await readRequestIntent(undefined, INPUT, { page: ops.page });
    expect(result).toEqual({
      intent: 'other',
      interpretation: 'reader_unavailable',
      failure: 'reader_unavailable',
    });
    expect(ops.texts).toEqual([
      'request intent unread skill=request-intent reason=reader_unavailable',
    ]);
    // Rule #1: nothing the parent wrote reaches #ops.
    expect(ops.texts.join(' ')).not.toContain('gmail');
    vi.restoreAllMocks();
  });

  it('tries twice on a failing model, then names model_failed and pages once', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const reader = fakeRequestIntentReader({ fail: true });
    const ops = pager();
    const result = await readRequestIntent(reader, INPUT, { page: ops.page });
    expect(result).toEqual({
      intent: 'other',
      interpretation: 'model_failed',
      failure: 'model_failed',
    });
    expect(reader.calls).toHaveLength(2);
    expect(ops.texts).toEqual(['request intent unread skill=request-intent reason=model_failed']);
    vi.restoreAllMocks();
  });

  it('takes the retry when the first attempt throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let attempts = 0;
    const flaky: RequestIntentReader = {
      async read(input) {
        attempts += 1;
        if (attempts === 1) throw new Error('timeout');
        return {
          intent: 'connect_gmail',
          verbatim: input.message,
          rationale: 'wants their mail read',
          confidence: 0.9,
        };
      },
    };
    const ops = pager();
    const result = await readRequestIntent(flaky, INPUT, { page: ops.page });
    expect(result).toEqual({
      intent: 'connect_gmail',
      interpretation: 'wants their mail read',
      failure: null,
    });
    expect(attempts).toBe(2);
    expect(ops.texts).toEqual([]);
    vi.restoreAllMocks();
  });

  it('runs the guards on what the model returns: a paraphrased echo is not a reading', async () => {
    const reader = fakeRequestIntentReader({
      answer: (input) => ({
        intent: 'connect_gmail',
        verbatim: input.message.toUpperCase(),
        rationale: 'fake',
        confidence: 0.99,
      }),
    });
    const result = await readRequestIntent(reader, INPUT);
    expect(result.intent).toBe('other');
    expect(result.failure).toBeNull();
  });

  it('survives a pager that throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await readRequestIntent(undefined, INPUT, {
      page: async () => {
        throw new Error('slack down');
      },
    });
    expect(result.failure).toBe('reader_unavailable');
    vi.restoreAllMocks();
  });
});
