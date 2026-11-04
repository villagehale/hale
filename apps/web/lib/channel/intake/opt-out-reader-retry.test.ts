import { afterEach, describe, expect, it, vi } from 'vitest';

const forceToolJson = vi.fn();
vi.mock('~/lib/pipeline/structured', () => ({
  forceToolJson: (...a: unknown[]) => forceToolJson(...a),
}));

// vitest.setup.ts already loaded the real module; load a fresh copy that sees the mock.
vi.resetModules();
const { createOptOutReader, readReplyOnce } = await import('./opt-out-reader');

const STOP = { value: { intent: 'stop', verbatim: 'leave me be', confirmation: 'Okay, done.' } };

/** The ops pager port, recording what it was asked to page. */
function recordingPager() {
  const pages: unknown[] = [];
  return {
    pages,
    pager: {
      page: async (page: unknown) => {
        pages.push(page);
        return 'paged' as const;
      },
    },
  };
}

describe('#868 opt-out reader: one retry, then null', () => {
  afterEach(() => {
    forceToolJson.mockReset();
    vi.restoreAllMocks();
  });

  it('retries once after a failure and returns the second read', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    forceToolJson.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(STOP);
    const { pages, pager } = recordingPager();
    const reading = await createOptOutReader({} as never, pager).read({
      text: 'leave me be',
      language: null,
    });
    expect(reading?.intent).toBe('stop');
    expect(forceToolJson).toHaveBeenCalledTimes(2);
    expect(pages).toEqual([]);
  });

  it('returns null after two failures and pages #ops once, without the text', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    forceToolJson.mockRejectedValue(new Error('down'));
    const { pages, pager } = recordingPager();
    const reading = await createOptOutReader({} as never, pager).read({
      text: 'leave me be',
      language: null,
    });
    expect(reading).toBeNull();
    expect(forceToolJson).toHaveBeenCalledTimes(2);
    expect(pages).toEqual([{ site: 'opt_out_unread', facts: {} }]);
  });

  it('does not remember a failed read: the next ask reads again', async () => {
    let calls = 0;
    const reader = {
      read: async () => {
        calls += 1;
        return calls === 1 ? null : { intent: 'none' as const, confirmation: '', language: null };
      },
    };
    const text = `retry-cache ${Math.random()}`;
    expect(await readReplyOnce(reader, { text, language: null })).toBeNull();
    await Promise.resolve();
    expect(await readReplyOnce(reader, { text, language: null })).toEqual({
      intent: 'none',
      confirmation: '',
      language: null,
    });
    expect(calls).toBe(2);
  });
});
