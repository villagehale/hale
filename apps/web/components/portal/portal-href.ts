import type { Route } from 'next';

/** Prefix a portal path. An empty base leaves the authed routes unchanged. */
export function portalHref(basePath: string, href: string): Route {
  return `${basePath}${href}` as Route;
}
