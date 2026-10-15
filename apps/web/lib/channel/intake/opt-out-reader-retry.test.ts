import { afterEach, describe, expect, it, vi } from 'vitest';

const forceToolJson = vi.fn();
vi.mock('~/lib/pipeline/structured', () => ({
  forceToolJson: (...a: unknown[]) => forceToolJson(...a),
}));

// vitest.setup.ts already loaded the real module; load a fresh copy that sees the mock.
vi.resetModules();
const { createOptOutReader, readTextOnce } = await import('./opt-out-reader');

const STOP = { value: { intent: 'stop', verbatim: 'leave me be', confirmation: 'Okay, done.' } };

describe('#868 opt-out reader: one retry, then null', () => {
  afterEach(() => {
    forceToolJson.mockReset();
    vi.restoreAllMocks();
  });

  it('retries once after a failure and returns the second read', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    forceToolJson.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(STOP);
    const reading = await createOptOutReader({} as never).read({
      text: 'leave me be',
      language: null,
    });
    expect(reading?.intent).toBe('stop');
    expect(forceToolJson).toHaveBeenCalledTimes(2);
  });

  it('returns null after two failures and logs it as urgent', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    forceToolJson.mockRejectedValue(new Error('down'));
    const reading = await createOptOutReader({} as never).read({
      text: 'leave me be',
      language: null,
    });
    expect(reading).toBeNull();
    expect(forceToolJson).toHaveBeenCalledTimes(2);
    expect(error.mock.calls.some(([meta]) => (meta as { urgent?: boolean })?.urgent === true)).toBe(
      true,
    );
  });

  it('does not remember a failed read: the next ask reads again', async () => {
    let calls = 0;
    const reader = {
      read: async () => {
        calls += 1;
        return calls === 1 ? null : { intent: 'none' as const, confirmation: '' };
      },
    };
    const text = `retry-cache ${Math.random()}`;
    expect(await readTextOnce(reader, { text, language: null })).toBeNull();
    await Promise.resolve();
    expect(await readTextOnce(reader, { text, language: null })).toEqual({
      intent: 'none',
      confirmation: '',
    });
    expect(calls).toBe(2);
  });
});
