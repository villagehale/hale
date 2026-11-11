import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import nextConfig from '~/next.config';
import {
  POSTHOG_PROXY_PATH,
  posthogAssetHost,
  posthogIngestHost,
  posthogProxyRewrites,
  posthogRegion,
  posthogUiHost,
} from './posthog-proxy';

describe('PostHog reverse proxy', () => {
  it('points the SDK at /ingest, not *.i.posthog.com', () => {
    expect(POSTHOG_PROXY_PATH).toBe('/ingest');
  });

  it('rewrites static and array before the catch-all, so the recorder is not sent to ingest', () => {
    const rules = posthogProxyRewrites('https://us.i.posthog.com');
    expect(rules.map((r) => r.source)).toEqual([
      '/ingest/static/:path*',
      '/ingest/array/:path*',
      '/ingest/:path*',
    ]);
    expect(rules[0]?.destination).toBe('https://us-assets.i.posthog.com/static/:path*');
    expect(rules[1]?.destination).toBe('https://us-assets.i.posthog.com/array/:path*');
    expect(rules[2]?.destination).toBe('https://us.i.posthog.com/:path*');
  });

  it('picks eu ingest and assets from an eu host', () => {
    expect(posthogRegion('https://eu.i.posthog.com')).toBe('eu');
    expect(posthogUiHost('https://eu.i.posthog.com')).toBe('https://eu.posthog.com');
    expect(posthogIngestHost('https://eu.i.posthog.com')).toBe('https://eu.i.posthog.com');
    expect(posthogAssetHost('https://eu.i.posthog.com')).toBe('https://eu-assets.i.posthog.com');
  });

  it('is wired in next.config and skipped by middleware', async () => {
    expect(nextConfig.skipTrailingSlashRedirect).toBe(true);
    if (typeof nextConfig.rewrites !== 'function') {
      throw new Error('next.config has no rewrites()');
    }
    const rules = await nextConfig.rewrites();
    const list = Array.isArray(rules)
      ? rules
      : [
          ...(rules && 'beforeFiles' in rules ? (rules.beforeFiles ?? []) : []),
          ...(rules && 'afterFiles' in rules ? (rules.afterFiles ?? []) : []),
          ...(rules && 'fallback' in rules ? (rules.fallback ?? []) : []),
        ];
    expect(list.some((r) => 'source' in r && r.source === '/ingest/:path*')).toBe(true);

    const middleware = readFileSync(
      fileURLToPath(new URL('../../middleware.ts', import.meta.url)),
      'utf8',
    );
    expect(middleware).toContain('ingest');
  });
});
