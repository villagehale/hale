import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright e2e config for @hale/web.
 *
 * These specs exercise the PUBLIC, pre-auth funnel against a deployed origin —
 * they do not start a local server. `PREVIEW_BASE_URL` points at whichever
 * environment is under test; it defaults to production (app.villagehale.com),
 * the LIVE pre-auth preview. Run with `pnpm --filter @hale/web test:e2e`.
 *
 * Kept out of the unit-test (vitest) and `tsc --noEmit` lanes: vitest only
 * collects `lib/**` + `components/**`, and the app tsconfig excludes `e2e/`
 * (which has its own tsconfig for Playwright types), so this never enters the
 * web typecheck/test gates.
 */
export default defineConfig({
  testDir: './e2e',
  // The local flag-on smoke (playwright.smoke.config.ts) owns e2e/smoke — those
  // specs need a seeded ephemeral DB + minted sessions and must never run against
  // the deployed origin this config targets.
  testIgnore: 'smoke/**',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  use: {
    baseURL: process.env.PREVIEW_BASE_URL ?? 'https://app.villagehale.com',
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
