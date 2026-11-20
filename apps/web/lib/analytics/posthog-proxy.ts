/**
 * First-party reverse proxy for posthog-js, so ad blockers that filter by
 * `*.i.posthog.com` still let events through. Path is `/ingest` (the launch
 * ticket's example). Rewrites live in next.config.ts; the SDK's `api_host` is
 * this path, and `ui_host` stays PostHog's real app origin for the toolbar.
 */

export const POSTHOG_PROXY_PATH = '/ingest';

export function posthogRegion(
  host: string | undefined = process.env.NEXT_PUBLIC_POSTHOG_HOST,
): 'us' | 'eu' {
  return (host ?? '').includes('eu.') ? 'eu' : 'us';
}

export function posthogUiHost(
  host: string | undefined = process.env.NEXT_PUBLIC_POSTHOG_HOST,
): string {
  return posthogRegion(host) === 'eu' ? 'https://eu.posthog.com' : 'https://us.posthog.com';
}

export function posthogIngestHost(
  host: string | undefined = process.env.NEXT_PUBLIC_POSTHOG_HOST,
): string {
  if (host && host.length > 0) return host.replace(/\/$/, '');
  return posthogRegion(host) === 'eu' ? 'https://eu.i.posthog.com' : 'https://us.i.posthog.com';
}

export function posthogAssetHost(
  host: string | undefined = process.env.NEXT_PUBLIC_POSTHOG_HOST,
): string {
  return posthogRegion(host) === 'eu'
    ? 'https://eu-assets.i.posthog.com'
    : 'https://us-assets.i.posthog.com';
}

export function posthogProxyRewrites(
  host: string | undefined = process.env.NEXT_PUBLIC_POSTHOG_HOST,
): Array<{ source: string; destination: string }> {
  const ingest = posthogIngestHost(host);
  const assets = posthogAssetHost(host);
  const path = POSTHOG_PROXY_PATH;
  return [
    { source: `${path}/static/:path*`, destination: `${assets}/static/:path*` },
    { source: `${path}/array/:path*`, destination: `${assets}/array/:path*` },
    { source: `${path}/:path*`, destination: `${ingest}/:path*` },
  ];
}
