import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';
import { MARKETING_SITE_URL, PRIVACY_URL, TERMS_URL } from './lib/legal-links';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  typedRoutes: true,
  // The policies moved to the marketing site (D20). These forwards are permanent
  // (308) and are kept FOREVER, not until a cleanup: sent emails, stored consent
  // records and already-shipped mobile builds still point at the app's legal URLs,
  // and none of those can be rewritten after the fact. Declared here rather than in
  // the middleware so a policy link never costs an Edge invocation, and so the
  // forward survives independently of the auth middleware's matcher.
  async redirects() {
    return [
      { source: '/terms', destination: TERMS_URL, permanent: true },
      { source: '/privacy', destination: PRIVACY_URL, permanent: true },
      // F14: the web onboarding wizard is deleted, not disabled. Its output was a
      // family with no phone number, and Hale cannot run a week for a family it
      // cannot text — so joining starts on the marketing site, which says exactly
      // that. Permanent and kept FOREVER for the same reason as the two above: the
      // live "Get started" buttons on the marketing site, already-sent emails and a
      // year of bookmarks all still point here, and none of them can be rewritten.
      // Both spellings are listed rather than relying on `:path*` to match zero
      // segments — the bare route is the one every old link actually uses.
      { source: '/onboarding', destination: MARKETING_SITE_URL, permanent: true },
      { source: '/onboarding/:path*', destination: MARKETING_SITE_URL, permanent: true },
      // Barton, and links already in the wild, use /signin (no hyphen). That path
      // 404s; /sign-in is the door. Permanent (308) and kept, same as the forwards
      // above. Both spellings are listed. The destination carries no query of its
      // own, so Next appends the request's query string (?foo=bar stays ?foo=bar).
      // With trailingSlash left off, Next also 308s /signin/ to /signin before this
      // rule; the explicit slash source is the same forward if that hop is skipped.
      { source: '/signin', destination: '/sign-in', permanent: true },
      { source: '/signin/', destination: '/sign-in', permanent: true },
    ];
  },
  transpilePackages: [
    '@hale/db',
    '@hale/types',
    '@hale/tools-contracts',
    '@hale/agent',
    '@hale/worker',
  ],
  serverExternalPackages: [
    'postgres',
    'pg-boss',
    // Authorized signup loads Playwright at runtime when the flag is on.
    // Absent in a runtime that did not install it — the runner hands back
    // browser_unavailable rather than bundling a browser into the function.
    '@playwright/test',
    'playwright',
    'playwright-core',
    // Remote hands. Loaded only when SIGNUP_SANDBOX_RUNTIME_ENABLED is exactly
    // `true` and the runtime id is vercel_sandbox. Never bundled into the function.
    '@vercel/sandbox',
  ],
  // The coach (and any web-side agent) reads the worker's single-source prompt +
  // model files off disk at runtime, plus the agent harness reads its skill files
  // (rule #2 — the skill markdown is the source of truth, never inlined). They
  // live outside apps/web, so Next won't trace them automatically — force them
  // into the function bundles, else the readFile throws in the Vercel serverless
  // runtime (works locally only).
  outputFileTracingRoot: repoRoot,
  // Globs are relative to this config's directory (apps/web); use ../ to reach
  // the repo root so the worker prompts + agent skills (read at runtime via
  // resolveRepoFile) actually land in the function bundle. outputFileTracingRoot
  // preserves their repo-root-relative paths, where resolveRepoFile finds them.
  outputFileTracingIncludes: {
    '/**': [
      '../worker/prompts/**',
      '../worker/src/anthropic/client.ts',
      '../../packages/agent/skills/**',
    ],
  },
  webpack: (config) => {
    // Workspace packages use ESM '.js' import specifiers against .ts sources;
    // webpack needs the alias tsc applies implicitly.
    config.resolve.extensionAlias = {
      '.js': ['.ts', '.tsx', '.js'],
      '.mjs': ['.mts', '.mjs'],
    };
    return config;
  },
};

export default config;
