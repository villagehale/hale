/**
 * Browser Use watch: Hale's own cron re-reads provider pages for schedules, openings
 * and waitlists. Off unless BROWSER_USE_WATCH_ENABLED is exactly `true`: `true\n`,
 * `TRUE`, `1` and `on` stay off, so a piped `echo` into `vercel env add` cannot start
 * paid runs nobody armed. Independent of the signup flags.
 */
export const BROWSER_USE_WATCH_ENABLED_ENV = 'BROWSER_USE_WATCH_ENABLED';

export function browserUseWatchEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[BROWSER_USE_WATCH_ENABLED_ENV] === 'true';
}
