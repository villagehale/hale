import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';
import { PRIVACY_URL, TERMS_URL } from './lib/legal-links';

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
    ];
  },
  transpilePackages: ['@hale/db', '@hale/types', '@hale/tools-contracts', '@hale/agent', '@hale/worker'],
  serverExternalPackages: ['postgres', 'pg-boss', '@node-rs/argon2'],
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
