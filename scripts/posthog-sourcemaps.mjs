#!/usr/bin/env node
// Upload a Next build's source maps to PostHog error tracking, then delete them.
//
//   node ../../scripts/posthog-sourcemaps.mjs <build-dir> <release-name>
//
// INERT WITHOUT A KEY: when POSTHOG_PERSONAL_API_KEY is unset (CI, previews, any deploy
// before Barton sets it) this prints one line and exits 0 — no download, no network, the
// build is unchanged. With the key set it runs `@posthog/cli sourcemap inject` then
// `upload --delete-after`, so no .map file is ever served from the deployment.
//
// The key is handed to the CLI through its own env var (POSTHOG_CLI_API_KEY) and is
// never printed or passed on a command line.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const [dir, releaseName] = process.argv.slice(2);
const key = process.env.POSTHOG_PERSONAL_API_KEY;

function shouldUpload(env = process.env) {
  return Boolean(env.POSTHOG_PERSONAL_API_KEY);
}

if (!shouldUpload()) {
  console.info('posthog-sourcemaps: POSTHOG_PERSONAL_API_KEY not set — skipping upload');
  process.exit(0);
}
if (!dir || !releaseName || !existsSync(dir)) {
  console.warn(`posthog-sourcemaps: build dir missing (${dir ?? 'none'}) — skipping upload`);
  process.exit(0);
}

const env = {
  ...process.env,
  POSTHOG_CLI_API_KEY: key,
  POSTHOG_CLI_PROJECT_ID: process.env.POSTHOG_PROJECT_ID || '486181',
  POSTHOG_CLI_HOST: process.env.POSTHOG_CLI_HOST || 'https://us.posthog.com',
};

function run(args) {
  const res = spawnSync('npx', ['-y', '@posthog/cli@latest', ...args], { env, stdio: 'inherit' });
  return res.status === 0;
}

// A failed upload must not fail the deploy: the app works without symbolication.
const ok =
  run(['sourcemap', 'inject', '--directory', dir]) &&
  run(['sourcemap', 'upload', '--directory', dir, '--release-name', releaseName, '--delete-after']);
console.info(`posthog-sourcemaps: ${ok ? 'uploaded' : 'upload failed (build continues)'}`);
