const PORTAL_HEADING_ROUTES = ['/home', '/messages', '/family', '/settings'] as const;

/**
 * Routes whose page renders the portal's single `<h1>` (PortalHeading or the
 * home greeting). The shell must not mount a second title on these paths.
 * Demoted routes still get the existing hero copy from the shell.
 */
export function portalOwnsHeading(pathname: string): boolean {
  return PORTAL_HEADING_ROUTES.some(
    (route) => pathname === route || pathname.startsWith(`${route}/`),
  );
}
