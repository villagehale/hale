import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import nextConfig from '~/next.config';
import { POSTHOG_PROXY_PATH, posthogProxyRewrites } from './posthog-proxy';

describe('PostHog reverse proxy (marketing site)', () => {
  it('uses the same /ingest path as the portal', () => {
    expect(POSTHOG_PROXY_PATH).toBe('/ingest');
  });

  it('is wired in next.config ahead of the next-intl catch-all, and skipped by middleware', async () => {
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
    const sources = list.map((r) => ('source' in r ? r.source : '')).filter(Boolean);
    for (const source of posthogProxyRewrites().map((r) => r.source)) {
      expect(sources).toContain(source);
    }

    const middleware = readFileSync(
      fileURLToPath(new URL('../../middleware.ts', import.meta.url)),
      'utf8',
    );
    expect(middleware).toMatch(/ingest/);
  });
});
