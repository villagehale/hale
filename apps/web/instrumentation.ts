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

  // Process-level crashes (worker code runs in this process — apps/worker is a library
  // the web functions import). Only installed when POSTHOG_PROJECT_API_KEY is set, so a
  // keyless deploy keeps Node's exact default behaviour.
  if (process.env.POSTHOG_PROJECT_API_KEY) {
    const { installProcessErrorHandlers } = await import('~/lib/analytics/exceptions');
    installProcessErrorHandlers();
  }
}

/**
 * Error tracking for every server request (API routes, crons, webhooks, RSC), via
 * Next's `onRequestError`. Dark until POSTHOG_PROJECT_API_KEY is set (exceptions.ts
 * returns 'not_configured' without touching the network). The error is REDACTED to its
 * class + frames, and the properties are the closed allowlist: route path, method,
 * surface. Never the message, never a header, never a body (rule #1).
 */
export async function onRequestError(
  err: unknown,
  request: { path: string; method: string },
  context: { routePath?: string; routeType?: string },
): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (!process.env.POSTHOG_PROJECT_API_KEY) return;
  const { captureSafeException, surfaceForRoute } = await import('~/lib/analytics/exceptions');
  // The ROUTE PATTERN (`/api/webhooks/[provider]`), never the concrete path: a path can
  // carry a token (`/a/<token>`), a pattern cannot.
  const route = context.routePath ?? 'unknown';
  await captureSafeException(err, 'system', {
    hale_surface: surfaceForRoute(route),
    route,
    method: request.method,
  });
}
