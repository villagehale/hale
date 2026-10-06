#!/usr/bin/env node
// Vercel production builds run this before `turbo build`. The deployment is
// aliased only after the build exits 0, so a failed migrate or a failed ledger
// check leaves the previous production deployment serving traffic.
//
// Preview builds and any non-Vercel invocation exit 0 without connecting.
// A production build with no database URL exits 1. The URL is never printed.

function isVercel() {
  return process.env.VERCEL === '1';
}

const vercelEnv = process.env.VERCEL_ENV;

if (!isVercel()) {
  console.info('Not a Vercel build — database migrations are not applied here.');
  process.exit(0);
}

if (vercelEnv !== 'production') {
  console.info(
    `Vercel ${vercelEnv ?? 'unknown'} build — database migrations run only for production.`,
  );
  process.exit(0);
}

const direct = process.env.DATABASE_DIRECT_URL;
const pooled = process.env.DATABASE_URL;
const hasUrl =
  (typeof direct === 'string' && direct.length > 0) ||
  (typeof pooled === 'string' && pooled.length > 0);

if (!hasUrl) {
  console.error(
    '::error::Production build refused: DATABASE_DIRECT_URL is not set on this Vercel build (DATABASE_URL is not set either). Hale will not ship code that may select columns whose migrations were not applied. Set DATABASE_DIRECT_URL on the hale-web project for the Production environment to the Supabase direct (port 5432, non-pooled) URL — the same name as the GitHub Actions secret DATABASE_DIRECT_URL. The variable must be available at build time (an encrypted Production variable is; a Sensitive variable is not).',
  );
  process.exit(1);
}

console.info('Production build — applying migrations before this deployment can be aliased.');
const { applyPendingMigrations } = await import('./apply-migrations.mjs');
const code = await applyPendingMigrations();
process.exit(code);
