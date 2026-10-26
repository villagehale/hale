import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';
import { retiredRegistrationRedirects } from './lib/site/retired-registration-redirects';

const withNextIntl = createNextIntlPlugin('./i18n/request.ts');

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // @hale/source-codes ships TypeScript source (no build step).
  transpilePackages: ['@hale/source-codes'],
  // Browser source maps exist only on a build that will upload them to PostHog and then
  // delete them (scripts/posthog-sourcemaps.mjs --delete-after). Without the key —
  // every build today — this is false and nothing changes.
  productionBrowserSourceMaps: Boolean(process.env.POSTHOG_PERSONAL_API_KEY),
  // The four dated city registration guides are retired. Each old URL — bare,
  // trailing-slash, and under /fr and /zh — 308s to that locale's /activities.
  // Declared here, not as a page, so the route components can be deleted and
  // the request query string is preserved (the destination has none of its own).
  async redirects() {
    return retiredRegistrationRedirects();
  },
};

export default withNextIntl(config);
