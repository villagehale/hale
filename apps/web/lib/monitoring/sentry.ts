import * as Sentry from '@sentry/nextjs';

/**
 * Error tracking, env-gated and privacy-first (hard rule #1) — the SAME shape as
 * the PostHog analytics layer: when no DSN is configured the whole layer is a
 * complete no-op (no init, no network), so the build ships safely now and starts
 * reporting the moment the user adds the DSN.
 *
 * `SENTRY_DSN` gates the server/edge SDK; `NEXT_PUBLIC_SENTRY_DSN` gates the
 * browser SDK (the only one that may be exposed to the client). A DSN is not a
 * secret, but it is read from env and NEVER hardcoded.
 *
 * Privacy: we capture EXCEPTIONS ONLY. No tracing, no profiling, no session
 * replay, and sendDefaultPii is left off — Hale handles children's data, so an
 * error report must carry a stack trace, never request bodies, headers, or PII.
 */

const SERVER_DSN = process.env.SENTRY_DSN;
const CLIENT_DSN = process.env.NEXT_PUBLIC_SENTRY_DSN;

/** True only when the server/edge DSN is configured — otherwise server-side error
 * tracking is a no-op. */
export function serverSentryEnabled(): boolean {
  return Boolean(SERVER_DSN);
}

/** True only when the browser DSN is configured — otherwise client-side error
 * tracking is a no-op. */
export function clientSentryEnabled(): boolean {
  return Boolean(CLIENT_DSN);
}

/** Initialize the server/edge SDK once, error-only. No-ops without a DSN. Called
 * from instrumentation.register() on the Node and edge runtimes. */
export function initServerSentry(): void {
  if (!SERVER_DSN) return;
  Sentry.init({
    dsn: SERVER_DSN,
    tracesSampleRate: 0,
    sendDefaultPii: false,
  });
}

/** Initialize the browser SDK once, error-only. No-ops without a DSN. Called from
 * instrumentation-client.ts. */
export function initClientSentry(): void {
  if (!CLIENT_DSN) return;
  Sentry.init({
    dsn: CLIENT_DSN,
    tracesSampleRate: 0,
    sendDefaultPii: false,
  });
}

/**
 * Report an exception. No-ops cleanly when Sentry is disabled (init never ran, so
 * Sentry.captureException is itself a no-op) — but we still re-`console.error` at
 * the call sites so a failure is never fully silent even without a DSN.
 */
export function captureException(error: unknown): void {
  Sentry.captureException(error);
}
