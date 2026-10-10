/**
 * Email doors retired from the portal. Phone sign-in, the texted /connect link,
 * Google (the Auth.js provider), and /oauth/authorize stay.
 *
 * These pages 308 to /sign-in. The Location is built from the origin alone, so a
 * reset token, a magic token, an invite token, or any other query does not ride
 * along. Next's config redirects append the request query when the destination
 * has none of its own — that is the wrong tool here.
 *
 * A different target from the receipts-room retirements, which land on /home.
 * /home is a protected route; sending a signed-out visitor there would bounce
 * them through the auth gate and put the old token back on /sign-in?callbackUrl.
 *
 * API routes are not in this list. /api/auth/magic-link/request and
 * /api/invite are deleted, so they 404. A 308 of a POST would still be an
 * email-shaped URL.
 */
export const RETIRED_AUTH_TARGET = '/sign-in';

const RETIRED_AUTH_EXACT = [
  '/forgot-password',
  '/reset-password',
  '/magic-link',
  '/m/magic',
  '/verify',
  '/invite',
] as const;

/** True for a retired email door, including a nested path. Never an /api route. */
export function isRetiredAuthPath(pathname: string): boolean {
  const path = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  return RETIRED_AUTH_EXACT.some((door) => path === door || path.startsWith(`${door}/`));
}

/**
 * Bare /sign-in on the request's origin. Search and hash of `requestUrl` are
 * dropped because the first argument is an absolute path on a base that is
 * only the origin.
 */
export function retiredAuthRedirectUrl(requestUrl: URL): URL {
  return new URL(RETIRED_AUTH_TARGET, requestUrl.origin);
}
