import { describe, expect, it } from 'vitest';
import { DeadlineError, runTurn, withTimeout } from './deadline';

describe('withTimeout', () => {
  it('rejects with the named reason when the work does not settle', async () => {
    await expect(withTimeout(new Promise(() => {}), 20, 'reader_timeout')).rejects.toMatchObject({
      name: 'DeadlineError',
      reason: 'reader_timeout',
    });
  });

  it('returns the value when the work finishes first', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 50, 'reader_timeout')).resolves.toBe('ok');
  });
});

describe('runTurn', () => {
  it('rejects when the signal aborts and does not leave the work unhandled', async () => {
    const signal = AbortSignal.timeout(20);
    const pending = runTurn(signal, () => new Promise(() => {}));
    await expect(pending).rejects.toBeInstanceOf(DeadlineError);
  });
});
