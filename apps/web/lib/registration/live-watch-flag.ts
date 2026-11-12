/**
 * VIL-423 · link-owned registration watches. Off until armed: a paste does not
 * create a watch, and the live refresh path stays idle.
 *
 * Exact `'true'`, no trim: a trailing newline from `vercel env add` must not arm it.
 */

export const REGISTRATION_LIVE_WATCH_ENABLED_ENV = 'REGISTRATION_LIVE_WATCH_ENABLED';

export function registrationLiveWatchEnabled(): boolean {
  return process.env[REGISTRATION_LIVE_WATCH_ENABLED_ENV] === 'true';
}
