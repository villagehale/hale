import { headers } from 'next/headers';
import { enforceRateLimit } from '~/lib/rate-limit/apply';

/**
 * Per-IP brute-force / signup-spam guard for the auth surface, keyed off the
 * request the server is currently handling (the IP comes from `next/headers`, so
 * callers don't pass a Request). Used at BOTH auth entry points so neither can be
 * hit unthrottled:
 *   - the Credentials `authorize` (covers /sign-in AND a direct POST to
 *     /api/auth/callback/credentials, which bypasses the server action);
 *   - the sign-up server action (which doesn't go through authorize).
 *
 * Fails CLOSED (rule #1): a limiter/DB outage must not silently lift the only
 * throttle on password guessing — over the cap OR on error, returns true (block).
 */
export async function authRateLimited(): Promise<boolean> {
  const forwarded = (await headers()).get('x-forwarded-for');
  // On Vercel the real client is the FIRST hop; the platform overwrites this
  // header, so it isn't client-spoofable behind the edge. No header → a fixed key
  // so the cap still applies rather than letting a header-less request through.
  const ip = forwarded?.split(',')[0]?.trim() || 'unknown';
  return (await enforceRateLimit('auth', ip, true)) !== null;
}
