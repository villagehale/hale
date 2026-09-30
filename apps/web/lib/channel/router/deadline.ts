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
