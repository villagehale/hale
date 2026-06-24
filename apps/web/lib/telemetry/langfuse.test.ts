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
 * The SDK is mocked at the module boundary; `@langfuse/otel` is mocked too so
 * constructing the shared LangfuseSpanProcessor needs no credentials/network.
 */

const startObservationMock = vi.fn();
const getActiveTraceIdMock = vi.fn();

vi.mock('@langfuse/otel', () => ({
  LangfuseSpanProcessor: class {
    forceFlush = vi.fn(async () => {});
  },
}));

vi.mock('@langfuse/tracing', () => ({
  // startActiveObservation runs the callback and returns its result (real shape).
  startActiveObservation: vi.fn(async (_name: string, fn: (span: unknown) => unknown) => fn({})),
  // propagateAttributes runs the callback (real shape: (attrs, cb) => cb()).
  propagateAttributes: vi.fn(async (_attrs: unknown, fn: () => unknown) => fn()),
  getActiveTraceId: () => getActiveTraceIdMock(),
  startObservation: (name: string, attrs: unknown, opts: unknown) =>
    startObservationMock(name, attrs, opts),
}));

import { traceAgentRun } from './langfuse';

beforeEach(() => {
  startObservationMock.mockReset();
  startObservationMock.mockReturnValue({ end: vi.fn() });
  getActiveTraceIdMock.mockReset();
  getActiveTraceIdMock.mockReturnValue('abc123def456abc123def456abc12345');
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('traceAgentRun', () => {
  it('creates a trace with the descriptive name and surfaces the trace id', async () => {
    const { startActiveObservation } = await import('@langfuse/tracing');

    const result = await traceAgentRun(
      { name: 'ask-hale', sessionId: 'conv-1', userId: 'user-1', metadata: { familyId: 'fam-1' } },
      async (trace) => {
        expect(trace.traceId).toBe('abc123def456abc123def456abc12345');
        return 'answer';
      },
    );

    expect(result).toBe('answer');
    expect(startActiveObservation).toHaveBeenCalledWith('ask-hale', expect.any(Function));
  });

  it('records a generation carrying the model and token usage as usageDetails', async () => {
    await traceAgentRun({ name: 'discovery' }, async (trace) => {
      trace.recordGeneration('discovery-llm-call', {
        model: 'claude-sonnet-4-6',
        usage: { promptTokens: 120, completionTokens: 45 },
      });
    });

    expect(startObservationMock).toHaveBeenCalledWith(
      'discovery-llm-call',
      {
        model: 'claude-sonnet-4-6',
        usageDetails: { input: 120, output: 45 },
      },
      { asType: 'generation' },
    );
  });

  it('does NOT propagate a Langfuse client error (best-effort, rule #8)', async () => {
    const { startActiveObservation } = await import('@langfuse/tracing');
    (startActiveObservation as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error('langfuse exporter exploded');
    });

    // The work still runs (uninstrumented) and its result is returned — no throw.
    const result = await traceAgentRun({ name: 'daily-brief' }, async (trace) => {
      expect(trace.traceId).toBeNull();
      return 'brief';
    });

    expect(result).toBe('brief');
  });

  it('swallows a generation-recording error without failing the run', async () => {
    startObservationMock.mockImplementationOnce(() => {
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
