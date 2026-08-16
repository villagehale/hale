/**
 * Surfaces retired by the receipts-room slimdown.
 *
 * The app is the RECEIPTS surface: a page earns its place only as a receipt, as a
 * control that cannot live in a text message, or as auth/token plumbing. These were
 * none of those — the web chat that competed with the product (Hale is a number you
 * text), the newborn-era logging surface, and village-era browsing.
 *
 * Every one answers with a PERMANENT redirect to /home. The forward is served from the
 * middleware rather than only from the page, because a page-level `redirect()` under
 * the streaming `force-dynamic` (authed) layout resolves as a mid-stream client
 * navigation — a 200 plus a soft push — not a redirect a browser, a crawler or a
 * link-checker can see. That is the same reason the /home demotion lives there. The
 * pages ALSO permanentRedirect, so a retired surface cannot render even if this gate is
 * bypassed — defense in depth, the way PROTECTED_PREFIXES backs the layout's own check.
 *
 * Their API routes are NOT retired, and must never be added here: /api/coach/* backs
 * mobile's Bearer bridge and the SMS coach, and /api/mobile/companion/* backs the
 * native Diary. Matching is prefix-on-segment, so an /api/* path never matches one of
 * these (it does not start with the prefix).
 */
export const RETIRED_PREFIXES = ['/coach', '/companion', '/saved'];

/** Where every retired surface lands. */
export const RETIRED_TARGET = '/home';

/** True when `pathname` is a retired surface, or sits underneath one. */
export function isRetiredPath(pathname: string): boolean {
  return RETIRED_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}
