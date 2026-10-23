#!/usr/bin/env node
// Upload a Next build's source maps to PostHog error tracking, then ALWAYS delete them.
//
//   node ../../scripts/posthog-sourcemaps.mjs <build-dir> <release-name>
//
// Maps exist only when POSTHOG_PERSONAL_API_KEY is set (next.config.ts
// productionBrowserSourceMaps). Whatever happens here — upload succeeds, fails, throws,
// or is skipped (no key, bad args) — every *.map under <build-dir> is deleted in a
// `finally`, so no map is ever served from the deployment.
//
// The key is handed to the CLI through its own env var (POSTHOG_CLI_API_KEY) and is
// never printed or passed on a command line. A failed upload never fails the build.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Exact version: a CLI release must not change what the build does without a PR. */
export const POSTHOG_CLI = '@posthog/cli@0.18.12';

/** Delete every *.map file under `dir`. Returns how many were removed. */
export function deleteMaps(dir) {
  if (!dir || !existsSync(dir)) return 0;
  let removed = 0;
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const path = join(d, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith('.map')) {
        rmSync(path, { force: true });
        removed += 1;
      }
    }
  };
  walk(dir);
  return removed;
}

function upload(dir, releaseName, env) {
  if (!env.POSTHOG_PERSONAL_API_KEY) {
    return 'skipped: POSTHOG_PERSONAL_API_KEY not set';
  }
  if (!releaseName || !existsSync(dir)) return 'skipped: build dir or release name missing';
  const cliEnv = {
    ...env,
    POSTHOG_CLI_API_KEY: env.POSTHOG_PERSONAL_API_KEY,
    POSTHOG_CLI_PROJECT_ID: env.POSTHOG_PROJECT_ID || '486181',
    POSTHOG_CLI_HOST: env.POSTHOG_CLI_HOST || 'https://us.posthog.com',
  };
  const run = (args) =>
    spawnSync('npx', ['-y', POSTHOG_CLI, ...args], { env: cliEnv, stdio: 'inherit' }).status === 0;
  const ok =
    run(['sourcemap', 'inject', '--directory', dir]) &&
    run(['sourcemap', 'upload', '--directory', dir, '--release-name', releaseName]);
  return ok ? 'uploaded' : 'upload failed (build continues)';
}

export function main(argv = process.argv.slice(2), env = process.env) {
  const [dir, releaseName] = argv;
  let outcome = 'upload threw (build continues)';
  try {
    outcome = upload(dir, releaseName, env);
  } catch {
    // Named below; never fails the build.
  } finally {
    const removed = deleteMaps(dir);
    console.info(`posthog-sourcemaps: ${outcome}; deleted ${removed} .map file(s)`);
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
