/**
 * Which paths the Edge middleware gates behind a session. Pure so middleware
 * stays thin and the list is unit-tested in isolation, the same way the invite
 * gate and the Bearer bridge are.
 *
 * This is defense in depth, not the only gate: every one of these routes is
 * rendered by the `(authed)` route group, whose layout redirects an
 * unauthenticated request on its own. The group name is not part of the URL, so
 * the middleware matcher cannot target the group — the prefixes are listed by
 * hand, which means a NEW authed route is protected by the layout but silently
 * missing from the Edge gate until it is added here.
 */
export const PROTECTED_PREFIXES = [
  '/admin',
  '/approvals',
  '/coach',
  '/companion',
  '/family',
  '/home',
  '/messages',
  '/plan',
  '/saved',
  '/settings',
  '/trail',
  '/village',
];

/** True when `pathname` is one of the gated routes, or sits underneath one. */
export function isProtectedPath(pathname: string): boolean {
  return PROTECTED_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/**
 * The founder-only analytics portal. Unlike every other protected prefix, an
 * unauthenticated hit here must answer 404 — never a redirect that advertises
 * the route exists (the nested (authed)/admin layout 404s non-admins the same way).
 */
export function isAdminPath(pathname: string): boolean {
  return pathname === '/admin' || pathname.startsWith('/admin/');
}
