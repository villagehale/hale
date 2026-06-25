/**
 * Next.js client instrumentation (runs once in the browser, before hydration).
 * Initializes Sentry browser error tracking — env-gated on NEXT_PUBLIC_SENTRY_DSN,
 * so a complete no-op (no init, no network) until the user adds the DSN, exactly
 * like the PostHog analytics layer. Privacy-first: exceptions only (no tracing,
 * no session replay), since Hale handles children's data (hard rule #1).
 */
import { initClientSentry } from '~/lib/monitoring/sentry';

initClientSentry();
