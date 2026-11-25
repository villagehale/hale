import {
  type BrowserUseEngineDeps,
  DEAD_QUEUE_STATUSES,
  POLL_INTERVAL_MS,
  QUEUE_DISPATCH_DEADLINE_MS,
} from './engine';

/**
 * VIL-718 · the next turn of a session whose browser is still open (POST /sessions/{id}/queue),
 * so the agent carries on in the browser the parent just used instead of starting a new one.
 * Waits for the turn to dispatch, then caps its run. `run_cancelled` when Browser Use dropped
 * the turn, `timeout` when it never dispatched. A Browser Use error throws, for the caller's
 * own `api_error`.
 */
export async function queueSessionRun(
  deps: BrowserUseEngineDeps,
  input: { sessionId: string; text: string; maxCostUsd: number },
): Promise<{ ok: true; runId: string } | { ok: false; detail: 'run_cancelled' | 'timeout' }> {
  const message = await deps.api.queueSessionMessage(input.sessionId, {
    text: input.text,
    interrupt: false,
  });
  let queued = message;
  const deadline = deps.now().getTime() + QUEUE_DISPATCH_DEADLINE_MS;
  while (!queued.runId) {
    if (DEAD_QUEUE_STATUSES.has(queued.status)) return { ok: false, detail: 'run_cancelled' };
    if (deps.now().getTime() >= deadline) return { ok: false, detail: 'timeout' };
    await deps.sleep(POLL_INTERVAL_MS);
    queued = await deps.api.getQueuedMessage(input.sessionId, message.id);
  }
  await deps.api.setSessionCostCap(input.sessionId, input.maxCostUsd);
  return { ok: true, runId: queued.runId };
}
