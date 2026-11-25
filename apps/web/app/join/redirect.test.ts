import { existsSync } from 'node:fs';
import { fileURLToPath, format as formatUrl } from 'node:url';
import { getRedirectStatus } from 'next/dist/lib/redirect-status';
import type { BaseNextRequest } from 'next/dist/server/base-http';
import { stringifyQuery } from 'next/dist/server/server-route-utils';
import { getPathMatch } from 'next/dist/shared/lib/router/utils/path-match';
import { prepareDestination } from 'next/dist/shared/lib/router/utils/prepare-destination';
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

/**
 * The same match Next's router uses for a redirect rule: strict path-to-regexp,
 * then prepareDestination with the request query merged in (appendParamsToQuery
 * is false for redirects), then the 308/307 from permanent.
 */
async function resolveRedirect(requestPath: string) {
  const url = new URL(requestPath, 'http://localhost');
  const query = Object.fromEntries(url.searchParams);
  const rules = await redirects();
  for (const rule of rules) {
    const params = getPathMatch(rule.source, {
      strict: true,
      removeUnnamedParams: true,
      sensitive: false,
    })(url.pathname);
    if (!params) continue;
    const { parsedDestination } = prepareDestination({
      appendParamsToQuery: false,
      destination: rule.destination,
      params,
      query,
    });
    const { query: merged, ...rest } = parsedDestination;
    rest.search = stringifyQuery({} as BaseNextRequest, merged);
    return {
      status: getRedirectStatus(rule),
      location: formatUrl(rest),
    };
  }
  return null;
}

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

  it('returns 308 from /founding?utm_source=meta&fbclid=abc to /join with the query kept, and from a subpath', async () => {
    await expect(resolveRedirect('/founding?utm_source=meta&fbclid=abc')).resolves.toEqual({
      status: 308,
      location: '/join?utm_source=meta&fbclid=abc',
    });
    await expect(resolveRedirect('/founding/extra?x=1')).resolves.toEqual({
      status: 308,
      location: '/join/extra?x=1',
    });
  });

  it('serves the page at /join and no longer at /founding', () => {
    expect(existsSync(here('page.tsx'))).toBe(true);
    expect(existsSync(here('../founding/page.tsx'))).toBe(false);
  });
});
