import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import nextConfig from '~/next.config';

/**
 * /founding moved to /join. The forward lives in next.config redirects — the
 * same permanent (308) seam as /signin — so it does not depend on the auth
 * middleware. Next keeps the request query when the destination has none of
 * its own. :path* does not match the bare route, and skipTrailingSlashRedirect
 * is on, so the slash spelling is listed on its own and lands on /join.
 */

async function redirects() {
  if (typeof nextConfig.redirects !== 'function') {
    throw new Error('next.config has no redirects()');
  }
  return nextConfig.redirects();
}

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

describe('/founding forwards to /join', () => {
  it('permanently redirects the bare path and the trailing slash, keeping the query', async () => {
    const rules = await redirects();
    for (const source of ['/founding', '/founding/']) {
      const rule = rules.find((r) => r.source === source);
      expect(rule, source).toMatchObject({
        destination: '/join',
        permanent: true,
      });
      expect(rule?.destination).not.toContain('?');
    }
  });

  it('permanently redirects a subpath onto the matching /join path, keeping the query', async () => {
    const rules = await redirects();
    const rule = rules.find((r) => r.source === '/founding/:path*');
    expect(rule).toMatchObject({
      destination: '/join/:path*',
      permanent: true,
    });
    expect(rule?.destination).not.toContain('?');
  });

  it('serves the page at /join and no longer at /founding', () => {
    expect(existsSync(here('page.tsx'))).toBe(true);
    expect(existsSync(here('../founding/page.tsx'))).toBe(false);
  });
});
