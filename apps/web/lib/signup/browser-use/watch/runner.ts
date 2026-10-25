import { loadCronSkill } from '~/lib/cron/skill';
import type { FetchLike } from '../client';
import { browserUseWatchApiFromEnv } from './api';
import type { WatchSweepDeps } from './sweep';

/** Real wiring. Null when BROWSER_USE_API_KEY is unset; the sweep names that. */
export function browserUseWatchDepsFromEnv(
  env: Record<string, string | undefined> = process.env,
  fetchImpl?: FetchLike,
): WatchSweepDeps | null {
  const configured = browserUseWatchApiFromEnv(env, fetchImpl);
  if (!configured.api) return null;
  return {
    api: configured.api,
    loadTask: async (skill) => (await loadCronSkill(skill)).instructions,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => new Date(),
  };
}
