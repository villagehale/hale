import { interestPassportEnabled } from './flag';

/**
 * Preview-only fixture for the interest passport review.
 *
 * All three have to be exact. `VERCEL_ENV=preview` is set by Vercel on preview
 * deployments and is `production` on production, so this cannot turn on there.
 * Preview builds also run with `NODE_ENV=production`, so that variable is not
 * the gate.
 */
export const INTEREST_PASSPORT_DEMO_ENV = 'INTEREST_PASSPORT_DEMO';

/**
 * Set by the middleware, and only the middleware, on the fixture family routes.
 * The authed layout treats it as permission to skip the session and the database.
 * A client-sent copy is stripped first.
 */
export const PASSPORT_DEMO_HEADER = 'x-hale-passport-demo';

const FIXTURE_CHILD_IDS = new Set(['preview-mia', 'preview-leo']);

export function interestPassportDemo(
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (env.VERCEL_ENV !== 'preview') return false;
  return interestPassportEnabled(env) && env[INTEREST_PASSPORT_DEMO_ENV] === 'true';
}

/** Family and the two fixture kids. Nothing else under /family. */
export function isPassportDemoPath(pathname: string): boolean {
  const path = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  if (path === '/family') return true;
  const childId = /^\/family\/([^/]+)$/.exec(path)?.[1];
  return childId !== undefined && FIXTURE_CHILD_IDS.has(childId);
}

/** The auth gate may let this request through with no session. Production never qualifies. */
export function passportDemoBypassesAuth(
  pathname: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return interestPassportDemo(env) && isPassportDemoPath(pathname);
}
