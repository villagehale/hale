import type { SignupBrowser } from '../types';

/** Runtimes the signup sandbox can hand the browser to. */
export type SignupBrowserRuntimeId = 'local' | 'vercel_sandbox' | 'browserbase';

/**
 * Why a runtime handed back no browser.
 *
 * `not_configured` — the selected adapter is missing an env var, so nothing was started.
 * `not_built` — the adapter slot exists and refuses to run (Browserbase).
 * `chromium_missing` — the local Playwright runtime has no Chromium binary.
 * `hands_failed` — a remote runtime was configured, then the hands process did not come up.
 * The sandbox is stopped when that happens.
 */
export type SignupRuntimeSkipped =
  | 'not_configured'
  | 'not_built'
  | 'chromium_missing'
  | 'hands_failed';

export interface SignupRuntimeAcquire {
  runtime: SignupBrowserRuntimeId | 'unset';
  browser: SignupBrowser | null;
  /** Null when a browser was acquired. */
  skipped: SignupRuntimeSkipped | null;
  /** Env var names that were absent. Values are never included. */
  missing: readonly string[];
}
