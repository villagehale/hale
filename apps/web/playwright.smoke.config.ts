import { defineConfig, devices } from '@playwright/test';

/**
 * The LOCAL flag-on smoke — the lane PR #577 proved was missing: tsc + unit tests
 * stay green while the first real authed render crashes into the error boundary.
 * Unlike playwright.config.ts (public funnel against a DEPLOYED origin), this one
 * boots `next start` itself against an ephemeral database and walks the authed
 * pages with minted session cookies. Run via `pnpm smoke` (repo root) or CI's
 * web-smoke job — both provision the DB, migrate, seed, and set the env below.
 */

// Fail NAMED before any browser launches, never a half-run that walks pages as a
// logged-out visitor: the spec mints session JWTs with this secret.
if (!process.env.AUTH_SECRET) {
  throw new Error(
    'playwright.smoke.config: AUTH_SECRET is not set — run via `pnpm smoke` (repo root) or the CI web-smoke job, which provision the smoke env.',
  );
}

// Port 3100 on purpose: a dev server on 3000 (possibly pointed at another DB, flag
// off) must never be mistaken for the server under test.
const PORT = 3100;

export default defineConfig({
  testDir: './e2e/smoke',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: 'list',
  outputDir: './e2e-artifacts/test-results',
  use: {
    baseURL: `http://localhost:${PORT}`,
    screenshot: 'on',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // The server log is an artifact: a boot-time crash or server-side render error
    // lands in e2e-artifacts/next-server.log, uploaded alongside the screenshots.
    command: `mkdir -p e2e-artifacts && next start --port ${PORT} > e2e-artifacts/next-server.log 2>&1`,
    url: `http://localhost:${PORT}/sign-in`,
    // Never reuse: an already-listening server is some OTHER server (wrong env,
    // wrong DB). Failing loud beats silently walking the wrong app.
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
