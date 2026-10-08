const PORTAL_HEADING_ROUTES = ['/home', '/messages', '/family', '/settings'] as const;

/** Seeded preview demo. Stripped before the heading check so Plan is not a second hero. */
const DEMO_PREFIX = '/demo/portal';

/**
 * Routes whose page renders the portal's single `<h1>` (PortalHeading or the
 * home greeting). The shell must not mount a second title on these paths.
 * Demoted routes still get the existing hero copy from the shell.
 */
export function portalOwnsHeading(pathname: string): boolean {
  const path = pathname.startsWith(DEMO_PREFIX)
    ? pathname.slice(DEMO_PREFIX.length) || '/'
    : pathname;
  return PORTAL_HEADING_ROUTES.some((route) => path === route || path.startsWith(`${route}/`));
}
