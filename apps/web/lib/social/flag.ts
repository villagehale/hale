/**
 * VIL-378 — hidden-social watchlist dark launch.
 *
 * Off unless the env is exactly `on`. Unset, `off`, and a trailing newline
 * from `vercel env add` all stay dark, so a poll never starts because a
 * truthy check read `'true\n'` or an empty string.
 */

export const SOCIAL_WATCHLIST_ENV = 'SOCIAL_WATCHLIST';

export function socialWatchlistEnabled(): boolean {
  return process.env[SOCIAL_WATCHLIST_ENV] === 'on';
}
