import type { SignupRuntimeAcquire } from './types';

/** Selecting this runtime is a named refusal. No session is opened and nothing is sent. */
export const BROWSERBASE_RUNTIME_ID = 'browserbase' as const;

/**
 * Browserbase adapter slot (VIL-395).
 *
 * Not built. A later adapter should implement `SignupHandsSession`: commands in,
 * snapshots out, with the same rule as Vercel Sandbox — the agent loop and the
 * consent check stay in `runAuthorizedSignup`. This function does not take an
 * API key and does not read parent data.
 */
export function acquireBrowserbaseRuntime(): SignupRuntimeAcquire {
  return {
    runtime: BROWSERBASE_RUNTIME_ID,
    browser: null,
    skipped: 'not_built',
    missing: [],
  };
}
