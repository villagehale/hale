import { describe, expect, it } from 'vitest';
import { DeadlineError, runTurn, runTurnThen, withTimeout } from './deadline';

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

describe('runTurnThen', () => {
  it('returns the turn even when the deadline fires while trailed work is still going', async () => {
    const signal = AbortSignal.timeout(30);
    let finished = false;
    const trailed = new Promise<void>((resolve) => {
      setTimeout(() => {
        finished = true;
        resolve();
      }, 60);
    });
    await expect(runTurnThen(signal, async () => 'sent', [trailed])).resolves.toBe('sent');
    expect(finished).toBe(true);
    expect(signal.aborted).toBe(true);
  });
});
