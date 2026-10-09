import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import nextConfig from '~/next.config';

/**
 * /signin (no hyphen) is the URL Barton uses. It 404s today; /sign-in is the door.
 * The forward lives in next.config redirects — the same permanent (308) seam as
 * /terms, /privacy, and /onboarding — so it does not depend on the auth middleware.
 *
 * Next keeps the request query when the destination has none of its own, so
 * /signin?foo=bar lands on /sign-in?foo=bar. trailingSlash is off, so Next's own
 * /:path+/ → /:path+ 308 also folds /signin/ onto /signin before this rule; the
 * slash source is listed anyway.
 */

const PORTAL_DESCRIPTION =
  'Sign in to Hale to see your family, your messages with Hale, and your settings.';

async function redirects() {
  if (typeof nextConfig.redirects !== 'function') {
    throw new Error('next.config has no redirects()');
  }
  return nextConfig.redirects();
}

describe('/signin forwards to /sign-in', () => {
  it('permanently redirects the bare path and the trailing slash, keeping the query', async () => {
    const rules = await redirects();
    for (const source of ['/signin', '/signin/']) {
      const rule = rules.find((r) => r.source === source);
      expect(rule, source).toMatchObject({
        destination: '/sign-in',
        permanent: true,
      });
      // A destination with its own query would replace the request's. This one
      // has none, which is how Next preserves ?foo=bar.
      expect(rule?.destination).not.toContain('?');
    }
  });

  it('does not turn off the built-in trailing-slash 308 that also covers /signin/', () => {
    expect(nextConfig.trailingSlash).toBeFalsy();
    expect(nextConfig.skipTrailingSlashRedirect).toBeFalsy();
  });
});

describe('the portal meta description', () => {
  it('uses the approved sentence for description, Open Graph, and Twitter', () => {
    const layout = readFileSync(fileURLToPath(new URL('../layout.tsx', import.meta.url)), 'utf8');
    expect(layout).toContain(`'${PORTAL_DESCRIPTION}'`);
    expect(layout).toContain('description: PORTAL_DESCRIPTION');
    expect(layout).toContain('openGraph: { description: PORTAL_DESCRIPTION }');
    expect(layout).toContain('twitter: { description: PORTAL_DESCRIPTION }');
    expect(layout).not.toContain('This is the receipts room');
  });
});
