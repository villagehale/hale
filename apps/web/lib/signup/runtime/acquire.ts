import { playwrightSignupBrowser } from '../browser';
import type { SignupBrowser } from '../types';
import { acquireBrowserbaseRuntime } from './browserbase';
import { signupSandboxRuntimeEnabled } from './flag';
import type { SignupHandsSession } from './protocol';
import type { SignupBrowserRuntimeId, SignupRuntimeAcquire } from './types';
import {
  SIGNUP_BROWSER_RUNTIME_ENV,
  startVercelSandbox,
  vercelSandboxCreateParams,
} from './vercel';

export interface AcquireSignupBrowserDeps {
  env?: Record<string, string | undefined>;
  /** Defaults to local Playwright. Tests pass a fake that never launches Chromium. */
  local?: () => Promise<SignupBrowser | null>;
  /**
   * Defaults to `startVercelSandbox`, which is the only path that constructs
   * a Vercel Sandbox. Tests pass a fake session and never call the SDK.
   */
  vercelStart?: (env: Record<string, string | undefined>) => Promise<SignupHandsSession>;
}

/**
 * Picks the signup browser.
 *
 * Flag off: local Playwright, same as before this runtime existed. A missing
 * Chromium binary is `chromium_missing` and the runner reports
 * `browser_unavailable`.
 *
 * Flag exactly `true`: `SIGNUP_BROWSER_RUNTIME` selects `local`,
 * `vercel_sandbox`, or `browserbase`. An unset or unknown id is
 * `not_configured` and does not fall through to a paid sandbox.
 */
export async function acquireSignupBrowser(
  deps: AcquireSignupBrowserDeps = {},
): Promise<SignupRuntimeAcquire> {
  const env = deps.env ?? process.env;
  if (!signupSandboxRuntimeEnabled(env)) return report(await acquireLocal(deps));
  const runtime = signupBrowserRuntimeId(env);
  if (runtime === 'local') return report(await acquireLocal(deps));
  if (runtime === 'browserbase') return report(acquireBrowserbaseRuntime());
  if (runtime !== 'vercel_sandbox') {
    return report({
      runtime: 'unset',
      browser: null,
      skipped: 'not_configured',
      missing: [SIGNUP_BROWSER_RUNTIME_ENV],
    });
  }
  const built = vercelSandboxCreateParams(env);
  if (!built.ok) {
    return report({
      runtime: 'vercel_sandbox',
      browser: null,
      skipped: 'not_configured',
      missing: built.missing,
    });
  }
  try {
    const start = deps.vercelStart ?? startVercelSandbox;
    const session = await start(env);
    const { sessionSignupBrowser } = await import('./session-browser');
    return report({
      runtime: 'vercel_sandbox',
      browser: sessionSignupBrowser(session),
      skipped: null,
      missing: [],
    });
  } catch (err) {
    const skipped =
      err instanceof Error && err.message === 'not_configured' ? 'not_configured' : 'hands_failed';
    return report({ runtime: 'vercel_sandbox', browser: null, skipped, missing: [] });
  }
}

export function signupBrowserRuntimeId(
  env: Record<string, string | undefined>,
): SignupBrowserRuntimeId | 'unset' {
  const raw = env[SIGNUP_BROWSER_RUNTIME_ENV];
  if (raw === 'local' || raw === 'vercel_sandbox' || raw === 'browserbase') return raw;
  return 'unset';
}

async function acquireLocal(deps: AcquireSignupBrowserDeps): Promise<SignupRuntimeAcquire> {
  const load = deps.local ?? playwrightSignupBrowser;
  const browser = await load();
  if (!browser) {
    return { runtime: 'local', browser: null, skipped: 'chromium_missing', missing: [] };
  }
  return { runtime: 'local', browser, skipped: null, missing: [] };
}

function report(acquired: SignupRuntimeAcquire): SignupRuntimeAcquire {
  if (acquired.skipped) {
    console.warn(
      { runtime: acquired.runtime, skipped: acquired.skipped, missing: acquired.missing },
      'signup browser runtime unavailable',
    );
  }
  return acquired;
}
