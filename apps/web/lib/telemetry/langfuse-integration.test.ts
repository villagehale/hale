import { context } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { setLangfuseTracerProvider } from '@langfuse/tracing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { traceAgentRun } from './langfuse';

/**
 * Closed-loop test with a REAL Langfuse tracer over an in-memory OTel exporter —
 * no network, no real Langfuse. The AsyncLocalStorage context manager mirrors what
 * NodeSDK registers in production (instrumentation.ts), so trace nesting and the
 * active-trace-id lookup behave as they do on Vercel. This proves the
 * agent_runs.langfuse_trace_id loop: traceAgentRun surfaces a real, W3C-shaped
 * trace id that the caller threads into recordAgentRun, and the generation it
 * records nests under that trace carrying the model + token usage.
 */

const exporter = new InMemorySpanExporter();

beforeAll(() => {
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  setLangfuseTracerProvider(provider);
});

afterAll(() => {
  setLangfuseTracerProvider(null);
  context.disable();
});

describe('traceAgentRun — closed loop over a real in-memory tracer', () => {
  it('surfaces a real trace id and records a nested generation with model + usage', async () => {
    exporter.reset();

    const captured = await traceAgentRun(
      { name: 'ask-hale', sessionId: 'conv-9', userId: 'user-9', metadata: { familyId: 'fam-9' } },
      async (trace) => {
        trace.recordGeneration('ask-hale-loop', {
          model: 'claude-sonnet-4-6',
          usage: { promptTokens: 100, completionTokens: 30 },
        });
        return trace.traceId;
      },
    );

    // The id is real and W3C-shaped — this is exactly what gets written to
    // agent_runs.langfuse_trace_id, closing the loop.
    expect(captured).toMatch(/^[0-9a-f]{32}$/);

    const spans = exporter.getFinishedSpans();
    const root = spans.find((s) => s.name === 'ask-hale');
    const generation = spans.find((s) => s.name === 'ask-hale-loop');
    expect(root).toBeDefined();
    expect(generation).toBeDefined();

    // The trace is named and carries the correlating attributes (rule baseline).
    expect(root?.attributes['langfuse.trace.name']).toBe('ask-hale');
    expect(root?.attributes['user.id']).toBe('user-9');
    expect(root?.attributes['session.id']).toBe('conv-9');
    expect(root?.attributes['langfuse.trace.metadata.familyId']).toBe('fam-9');

    // The generation nests under the run's trace (same id the caller stored).
    expect(generation?.spanContext().traceId).toBe(captured);
    expect(generation?.attributes['langfuse.observation.type']).toBe('generation');
    expect(generation?.attributes['langfuse.observation.model.name']).toBe('claude-sonnet-4-6');
    const usageRaw = generation?.attributes['langfuse.observation.usage_details'];
    expect(JSON.parse(usageRaw as string)).toEqual({ input: 100, output: 30 });
  });
});
