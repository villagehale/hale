/**
 * Surfaces retired by the receipts-room slimdown.
 *
 * The app is the RECEIPTS surface: a page earns its place only as a receipt, as a
 * control that cannot live in a text message, or as auth/token plumbing. These were
 * none of those — the web chat that competed with the product (Hale is a number you
 * text), the newborn-era logging surface, and village-era browsing.
 *
 * Every one answers with a PERMANENT redirect to /home. The forward is declared in
 * next.config `redirects()` (308, before the auth middleware — the same seam as
 * /onboarding). The page files are gone. The middleware still answers with the same
 * 308, ahead of the auth gate, for a request that reaches the Edge: a page-level
 * `redirect()` under the streaming `(authed)` layout is a soft client navigation, not
 * a redirect a browser or a crawler can see, so the gate cannot live only in a page.
 *
 * Their API routes are NOT retired, and must never be added here: /api/coach/* backs
 * the SMS coach. Matching is prefix-on-segment, so an /api/* path never matches one of
 * these (it does not start with the prefix).
 */
export const RETIRED_PREFIXES = ['/coach', '/companion', '/saved'];

/** Where every retired surface lands. */
export const RETIRED_TARGET = '/home';

/** True when `pathname` is a retired surface, or sits underneath one. */
export function isRetiredPath(pathname: string): boolean {
  return RETIRED_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}
