import { headers } from 'next/headers';
import { enforceRateLimit } from '~/lib/rate-limit/apply';

/**
 * Per-IP brute-force guard for the auth surface, keyed off the request the server
 * is currently handling (the IP comes from `next/headers`, so callers don't pass
 * a Request). The phone doors call it inside authorize, so the cap covers the
 * form and a direct POST to that provider's callback:
 *   - claim-phone: /sign-in and /api/auth/callback/claim-phone
 *   - channel-link: /connect and /api/auth/callback/channel-link
 * The claim-phone code-request route calls it too.
 *
 * Fails CLOSED (rule #1): a limiter/DB outage must not silently lift the throttle
 * — over the cap OR on error, returns true (block).
 */
export async function authRateLimited(): Promise<boolean> {
  const forwarded = (await headers()).get('x-forwarded-for');
  // On Vercel the real client is the FIRST hop; the platform overwrites this
  // header, so it isn't client-spoofable behind the edge. No header → a fixed key
  // so the cap still applies rather than letting a header-less request through.
  const ip = forwarded?.split(',')[0]?.trim() || 'unknown';
  return (await enforceRateLimit('auth', ip, true)) !== null;
}
