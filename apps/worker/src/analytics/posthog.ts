import { PostHog } from 'posthog-node';

/**
 * The worker's PostHog clients — the ONLY `new PostHog(` in apps/worker. A copy of
 * apps/web/lib/analytics/posthog-node.ts, because the worker cannot import from
 * apps/web (web depends on the worker, not the reverse).
 *
 *  - `productClient()` — launch product events. NEXT_PUBLIC_POSTHOG_KEY. `privacyMode: true`.
 *  - `projectClient()` — $ai_generation and $exception. POSTHOG_PROJECT_API_KEY.
 *    `privacyMode` stays on unless POSTHOG_LLM_CONTENT_ENABLED is exactly `true`.
 *
 * Unset key → null, and every caller is a named no-op (rule #11): no client, no network.
 */

const DEFAULT_HOST = 'https://us.i.posthog.com';

let product: PostHog | null | undefined;
let project: PostHog | null | undefined;
let shutdownHooked = false;

function hookShutdown(): void {
  if (shutdownHooked) return;
  shutdownHooked = true;
  const flush = () => {
    void flushPosthog();
  };
  process.on('beforeExit', flush);
}

function host(): string {
  return process.env.POSTHOG_HOST || process.env.NEXT_PUBLIC_POSTHOG_HOST || DEFAULT_HOST;
}

function build(key: string, privacyMode: boolean): PostHog {
  return new PostHog(key, {
    host: host(),
    flushAt: 1,
    flushInterval: 0,
    privacyMode,
    disableGeoip: true,
    requestTimeout: 4_000,
    fetchRetryCount: 0,
  });
}

export function productClient(): PostHog | null {
  if (product !== undefined) return product;
  const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  product = key ? build(key, true) : null;
  if (product) hookShutdown();
  return product;
}

export function projectClient(): PostHog | null {
  if (project !== undefined) return project;
  const key = process.env.POSTHOG_PROJECT_API_KEY;
  project = key ? build(key, process.env.POSTHOG_LLM_CONTENT_ENABLED !== 'true') : null;
  if (project) hookShutdown();
  return project;
}

/** Flush the worker clients. Never throws: analytics must not fail a parent reply. */
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

/** Test seam: env is read once per process. */
export function resetPosthogClientForTests(): void {
  product = undefined;
  project = undefined;
}
