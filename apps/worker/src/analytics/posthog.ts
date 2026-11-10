import { PostHog } from 'posthog-node';

/**
 * The worker's PostHog client — the ONLY `new PostHog(` in apps/worker. A copy of
 * apps/web/lib/analytics/posthog-node.ts's project client, because the worker cannot
 * import from apps/web (web depends on the worker, not the reverse).
 *
 * Reads POSTHOG_PROJECT_API_KEY. Unset → null, and every caller is a named no-op
 * (rule #11): no client, no network. `privacyMode: true` always.
 */

let project: PostHog | null | undefined;

export function projectClient(): PostHog | null {
  if (project !== undefined) return project;
  const key = process.env.POSTHOG_PROJECT_API_KEY;
  project = key
    ? new PostHog(key, {
        host:
          process.env.POSTHOG_HOST ||
          process.env.NEXT_PUBLIC_POSTHOG_HOST ||
          'https://us.i.posthog.com',
        flushAt: 1,
        flushInterval: 0,
        privacyMode: true,
        disableGeoip: true,
        requestTimeout: 4_000,
        fetchRetryCount: 0,
      })
    : null;
  return project;
}

/** Test seam: env is read once per process. */
export function resetPosthogClientForTests(): void {
  project = undefined;
}
