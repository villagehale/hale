import { loadCronSkill } from '~/lib/cron/skill';
import { type BROWSER_USE_API_KEY_ENV, type FetchLike, browserUseApiFromEnv } from './client';
import {
  type BrowserUseEngineDeps,
  type BrowserUseSignupInput,
  type BrowserUseSignupResult,
  runBrowserUseSignup,
} from './engine';
import { playwrightSessionSeeder } from './seed';
import type { RemoteProfileDeleter } from './vault';
import { type SignupWalletSource, browserUseStripeLinkWallet } from './wallet';

export interface BrowserUseSignupRunner {
  run(input: BrowserUseSignupInput): Promise<BrowserUseSignupResult>;
}

export type BrowserUseSignupRunnerFromEnv =
  | { runner: BrowserUseSignupRunner; deps: BrowserUseEngineDeps; skipped: null; missing: [] }
  | {
      runner: null;
      deps: null;
      skipped: 'not_configured';
      missing: [typeof BROWSER_USE_API_KEY_ENV];
    };

export type SignupWalletFromEnv =
  | { source: SignupWalletSource; skipped: null }
  | { source: null; skipped: 'not_configured' };

/** The Stripe Link wallet through Browser Use. Named absence without a key. */
export function signupWalletFromEnv(
  env: Record<string, string | undefined> = process.env,
  fetchImpl?: FetchLike,
): SignupWalletFromEnv {
  const configured = browserUseApiFromEnv(env, fetchImpl);
  if (!configured.api) return { source: null, skipped: 'not_configured' };
  return { source: browserUseStripeLinkWallet(configured.api), skipped: null };
}

/** Real wiring. Named absence when BROWSER_USE_API_KEY is unset (rule #11). */
export function browserUseSignupRunnerFromEnv(
  env: Record<string, string | undefined> = process.env,
  fetchImpl?: FetchLike,
): BrowserUseSignupRunnerFromEnv {
  const configured = browserUseApiFromEnv(env, fetchImpl);
  if (!configured.api) {
    return { runner: null, deps: null, skipped: 'not_configured', missing: configured.missing };
  }
  const deps: BrowserUseEngineDeps = {
    api: configured.api,
    seeder: playwrightSessionSeeder(),
    loadTask: async (skill) => (await loadCronSkill(skill)).instructions,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => new Date(),
  };
  return {
    runner: { run: (input) => runBrowserUseSignup(input, deps) },
    deps,
    skipped: null,
    missing: [],
  };
}

/** For the delete sweep: delete remote profiles when configured, else say so. */
export function remoteProfileDeleterFromEnv(
  env: Record<string, string | undefined> = process.env,
  fetchImpl?: FetchLike,
): RemoteProfileDeleter {
  const configured = browserUseApiFromEnv(env, fetchImpl);
  if (!configured.api) return { kind: 'not_configured' };
  const api = configured.api;
  return { kind: 'api', deleteProfile: (profileId) => api.deleteProfile(profileId) };
}
