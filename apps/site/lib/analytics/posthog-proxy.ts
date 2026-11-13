/**
 * First-party reverse proxy for posthog-js on villagehale.com. Path is `/ingest`.
 * next-intl's middleware must skip this path or it prefixes `/en/ingest/...`
 * and events 404.
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
