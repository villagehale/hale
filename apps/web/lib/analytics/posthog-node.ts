import { PostHog } from 'posthog-node';

/**
 * The two server-side PostHog clients, and the ONLY place `new PostHog(` is written in
 * apps/web (posthog-node-singleton.test.ts pins it).
 *
 *  - `productClient()` — product events (the SMS funnel, inbound counts, agent-error
 *    rates). Reads NEXT_PUBLIC_POSTHOG_KEY, the same key the browser provider reads,
 *    so the funnel lands in the same project as the landing and portal events.
 *  - `projectClient()` — LLM generations ($ai_generation) and exceptions ($exception).
 *    Reads POSTHOG_PROJECT_API_KEY, a SEPARATE env var on purpose: tracing and error
 *    tracking ship dark, and turn on only when that key is set (Barton's call).
 *
 * A MISSING KEY IS A NAMED ABSENCE (rule #11): each getter returns null and the caller
 * returns 'not_configured'. No client is constructed, no network is touched.
 *
 * Serverless posture: `flushAt: 1, flushInterval: 0` so an event leaves as soon as it
 * is captured, and every caller awaits `flush()` (or the route awaits
 * `flushPosthog()` inside `after()`), so a frozen lambda does not strand a queue.
 * `privacyMode: true` is set on BOTH clients: posthog-node's LLM layer then never
 * attaches prompt or completion bodies, and our own generation builder
 * (llm-trace.ts) never sets them in the first place.
 */

const DEFAULT_HOST = 'https://us.i.posthog.com';

let product: PostHog | null | undefined;
let project: PostHog | null | undefined;

function host(): string {
  return process.env.POSTHOG_HOST || process.env.NEXT_PUBLIC_POSTHOG_HOST || DEFAULT_HOST;
}

function build(key: string): PostHog {
  return new PostHog(key, {
    host: host(),
    flushAt: 1,
    flushInterval: 0,
    privacyMode: true,
    disableGeoip: true,
    // A hung PostHog must not hold a webhook or a cron; one try, short bound.
    requestTimeout: 4_000,
    fetchRetryCount: 0,
  });
}

/** The product-events client, or null when NEXT_PUBLIC_POSTHOG_KEY is unset. */
export function productClient(): PostHog | null {
  if (product !== undefined) return product;
  const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  product = key ? build(key) : null;
  return product;
}

/** The LLM-tracing + error-tracking client, or null when POSTHOG_PROJECT_API_KEY is unset. */
export function projectClient(): PostHog | null {
  if (project !== undefined) return project;
  const key = process.env.POSTHOG_PROJECT_API_KEY;
  project = key ? build(key) : null;
  return project;
}

/** True only when LLM tracing / error tracking will actually send. */
export function projectTracingEnabled(): boolean {
  return Boolean(process.env.POSTHOG_PROJECT_API_KEY);
}

/**
 * Flush whatever is queued on either client. Never throws: a route calls this inside
 * `after()` / `finally`, and analytics must not be able to fail a parent's request.
 */
export async function flushPosthog(): Promise<void> {
  await Promise.all(
    [product, project].map(async (c) => {
      if (!c) return;
      try {
        await c.flush();
      } catch (err) {
        console.warn('analytics: posthog flush failed', {
          err: err instanceof Error ? err.name : 'unknown',
        });
      }
    }),
  );
}

/** Test seam: env is read once per process; tests flip it between cases. */
export function resetPosthogClientsForTests(): void {
  product = undefined;
  project = undefined;
}
