import { AsyncLocalStorage } from 'node:async_hooks';
import {
  CALL_TIMEOUT_MS,
  GATE_TIMEOUT,
  OFF_DOMAIN_TIMEOUT,
  READER_TIMEOUT,
  TURN_TIMEOUT,
} from '~/lib/channel/config';

/**
 * A bound fired. `reason` is one of the named outcomes in channel/config.ts.
 * The message is the reason alone — never the parent's text (rule #1).
 */
export class DeadlineError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.name = 'DeadlineError';
    this.reason = reason;
  }
}

const TURN_REASONS = new Set([READER_TIMEOUT, GATE_TIMEOUT, OFF_DOMAIN_TIMEOUT]);

/** A reader, gate, or screen that gave up, or a postgres.js query the client
 * abandoned. A real database error is not one of these. */
export function isCallTimeout(err: unknown): boolean {
  if (err instanceof DeadlineError) return TURN_REASONS.has(err.reason);
  return err instanceof Error && err.name === 'QueryTimeoutError';
}

export function isTurnTimeout(err: unknown): boolean {
  return err instanceof DeadlineError && err.reason === TURN_TIMEOUT;
}

/**
 * Resolve with `work`, or reject with {@link DeadlineError} once `ms` passes.
 * Does not cancel `work`. Callers that must not keep going check the turn
 * signal before they send.
 */
export function withTimeout<T>(work: Promise<T>, ms: number, reason: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new DeadlineError(reason)), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

const turnScope = new AsyncLocalStorage<AbortSignal>();
const deadlineAt = new WeakMap<AbortSignal, number>();

/** The turn's deadline signal, remembering when it fires so a step can ask how much of
 * the turn is left before it starts (VIL-581: a claim read the turn cannot finish is
 * never started). */
export function turnDeadlineSignal(ms: number): AbortSignal {
  const signal = AbortSignal.timeout(ms);
  deadlineAt.set(signal, Date.now() + ms);
  return signal;
}

/** Milliseconds left in this turn, or undefined outside a turn made by
 * {@link turnDeadlineSignal}. */
export function turnRemainingMs(): number | undefined {
  const signal = turnScope.getStore();
  const at = signal ? deadlineAt.get(signal) : undefined;
  return at === undefined ? undefined : at - Date.now();
}

export function currentTurnSignal(): AbortSignal | undefined {
  return turnScope.getStore();
}

/** Throw when this turn's deadline has already fired, so a late path cannot
 * send after the drain has moved on. */
export function assertTurnLive(): void {
  const signal = turnScope.getStore();
  if (signal?.aborted) throw new DeadlineError(TURN_TIMEOUT);
}

export function turnSignalAborted(): boolean {
  return turnScope.getStore()?.aborted === true;
}

/**
 * Run the turn inside the deadline, then await work the turn scheduled but
 * must not be timed by that deadline.
 *
 * A check-back extraction that is still inside `runTurn` can abort the turn
 * after the reply has already gone out. The abort then logs "nothing sent"
 * and records a deferred re-drive. Trailed work is awaited only after the
 * turn has resolved, and a rejection from it is swallowed: the parent
 * already has the text.
 */
export async function runTurnThen<T>(
  signal: AbortSignal,
  work: () => Promise<T>,
  trailed: readonly Promise<unknown>[],
): Promise<T> {
  const result = await runTurn(signal, work);
  await Promise.all(trailed.map((job) => Promise.resolve(job).catch(() => undefined)));
  return result;
}

/**
 * Run `work` inside the turn's abort scope, and reject when `signal` aborts
 * even if `work` is still going. The rejection is {@link DeadlineError} with
 * {@link TURN_TIMEOUT}. `work` is still attached, so its later rejection is
 * not an unhandled rejection.
 */
export function runTurn<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  return turnScope.run(signal, () => {
    const pending = work();
    if (signal.aborted) {
      void pending.catch(() => {});
      return Promise.reject(new DeadlineError(TURN_TIMEOUT));
    }
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        void pending.catch(() => {});
        reject(new DeadlineError(TURN_TIMEOUT));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      pending.then(
        (value) => {
          signal.removeEventListener('abort', onAbort);
          resolve(value);
        },
        (err) => {
          signal.removeEventListener('abort', onAbort);
          reject(err);
        },
      );
    });
  });
}

export { CALL_TIMEOUT_MS };
