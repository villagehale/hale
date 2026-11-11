import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * traceAgentRun wiring, with a FAKE Langfuse SDK (no real network). We assert the
 * Langfuse baseline + the Hale rules:
 *   - a trace is created with the right descriptive NAME,
 *   - a generation carries the model + token usage (so Langfuse computes cost),
 *   - the active trace id is surfaced so the caller can close the agent_runs loop,
 *   - a thrown Langfuse client error does NOT propagate out of the agent path
 *     (rule #8 — tracing is best-effort), while a genuine work error still does.
 *
 * Spies land on `tracingSdk` rather than `vi.mock('@langfuse/tracing')`: setupFiles
 * and the coach graph load this module before a suite mock can rebind its imports.
 */

vi.mock('@langfuse/otel', () => ({
  LangfuseSpanProcessor: class {
    forceFlush = vi.fn(async () => {});
  },
}));

import { traceAgentRun, tracingSdk } from './langfuse';

const TRACE_ID = 'abc123def456abc123def456abc12345';

beforeEach(() => {
  vi.spyOn(tracingSdk, 'startActiveObservation').mockImplementation(async (_name, fn) =>
    fn({} as never),
  );
  vi.spyOn(tracingSdk, 'propagateAttributes').mockImplementation(async (_attrs, fn) => fn());
  vi.spyOn(tracingSdk, 'getActiveTraceId').mockReturnValue(TRACE_ID);
  vi.spyOn(tracingSdk, 'startObservation').mockReturnValue({ end: vi.fn() } as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('traceAgentRun', () => {
  it('creates a trace with the descriptive name and surfaces the trace id', async () => {
    const result = await traceAgentRun(
      { name: 'ask-hale', sessionId: 'conv-1', userId: 'user-1', metadata: { familyId: 'fam-1' } },
      async (trace) => {
        expect(trace.traceId).toBe(TRACE_ID);
        return 'answer';
      },
    );

    expect(result).toBe('answer');
    expect(tracingSdk.startActiveObservation).toHaveBeenCalledWith('ask-hale', expect.any(Function));
  });

  it('records a generation carrying the model and token usage as usageDetails', async () => {
    await traceAgentRun({ name: 'discovery' }, async (trace) => {
      trace.recordGeneration('discovery-llm-call', {
        model: 'claude-sonnet-4-6',
        usage: { promptTokens: 120, completionTokens: 45 },
      });
    });

    expect(tracingSdk.startObservation).toHaveBeenCalledWith(
      'discovery-llm-call',
      {
        model: 'claude-sonnet-4-6',
        usageDetails: { input: 120, output: 45 },
      },
      { asType: 'generation' },
    );
  });

  it('does NOT propagate a Langfuse client error (best-effort, rule #8)', async () => {
    vi.mocked(tracingSdk.startActiveObservation).mockImplementationOnce(() => {
      throw new Error('langfuse exporter exploded');
    });

    // The work still runs (uninstrumented) and its result is returned — no throw.
    const result = await traceAgentRun({ name: 'ask-hale' }, async (trace) => {
      expect(trace.traceId).toBeNull();
      return 'answer';
    });

    expect(result).toBe('answer');
  });

  it('swallows a generation-recording error without failing the run', async () => {
    vi.mocked(tracingSdk.startObservation).mockImplementationOnce(() => {
      throw new Error('startObservation failed');
    });

    const result = await traceAgentRun({ name: 'classify-event' }, async (trace) => {
      trace.recordGeneration('classify-llm-call', {
        model: 'claude-haiku-4-5',
        usage: { promptTokens: 10, completionTokens: 5 },
      });
      return 'classified';
    });

    expect(result).toBe('classified');
  });

  it('still propagates a genuine work error (telemetry must not swallow real failures)', async () => {
    await expect(
      traceAgentRun({ name: 'review-action' }, async () => {
        throw new Error('reviewer blew up');
      }),
    ).rejects.toThrow('reviewer blew up');
  });
});
