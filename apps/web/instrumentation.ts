/**
 * Next.js instrumentation hook (runs once at server startup, before any route).
 * Registers the shared Langfuse span processor on a Node tracer provider so every
 * web-side agent trace has somewhere to export to, and so OTel context propagates
 * across async boundaries (the AsyncLocalStorage context manager NodeTracerProvider
 * registers is what makes nested spans + getActiveTraceId work).
 *
 * We use NodeTracerProvider rather than the @opentelemetry/sdk-node umbrella: the
 * latter pulls in the gRPC OTLP exporter (@grpc/grpc-js → node `zlib`), which the
 * Next/webpack serverless bundle can't resolve. The LangfuseSpanProcessor brings
 * its own HTTP exporter, so the heavy umbrella is unnecessary.
 *
 * The processor itself (with the explicit HIPAA-instance credentials + the rule-#1
 * mask) lives in lib/telemetry/langfuse.ts and is reused by the route handlers to
 * flush. The Langfuse tracer is guarded to the Node.js runtime (agent routes never
 * run on the edge).
 */

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') {
    return;
  }
  const { NodeTracerProvider } = await import('@opentelemetry/sdk-trace-node');
  const { langfuseSpanProcessor } = await import('~/lib/telemetry/langfuse');

  const provider = new NodeTracerProvider({ spanProcessors: [langfuseSpanProcessor] });
  provider.register();
}
