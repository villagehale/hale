import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  typedRoutes: true,
  transpilePackages: ['@hale/db', '@hale/types', '@hale/tools-contracts'],
  serverExternalPackages: ['postgres', 'pg-boss'],
  // The coach (and any web-side agent) reads the worker's single-source prompt +
  // model files off disk at runtime. They live outside apps/web, so Next won't
  // trace them automatically — force them into the function bundles, else the
  // readFileSync throws in the Vercel serverless runtime (works locally only).
  outputFileTracingRoot: repoRoot,
  outputFileTracingIncludes: {
    '/**': ['apps/worker/prompts/**', 'apps/worker/src/anthropic/client.ts'],
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
