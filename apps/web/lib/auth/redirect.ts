/**
 * Clamp a post-auth redirect target to a same-origin relative path.
 *
 * A bare `startsWith('/')` is not enough: `//evil.com` and `/\evil.com` start
 * with `/` yet browsers resolve them as protocol-relative URLs. Encoded forms
 * (`/%2F%2F`, `/%5C`, `/%00`) and a hop back to `/sign-in` or `/signin` are
 * rejected too, so a crafted `callbackUrl` can neither leave the origin nor
 * loop the door. Anything else falls back (home, unless the caller names one).
 */
const BASE = 'https://hale.invalid';
/** The door itself. Sending a session back here signs them in and bounces again. */
const SIGN_IN_PATH = /^\/sign-?in(?:\/|$)/i;

/** Stamped by the middleware so the authed layout can rebuild the return path. */
export const RETURN_PATH_HEADER = 'x-hale-return-path';

export function safeInternalRedirect(target: string | undefined, fallback = '/home'): string {
  if (typeof target !== 'string' || target.length === 0) return fallback;
  if (!isSafeInternalPath(target, 0)) return fallback;
  return target;
}

/**
 * `/sign-in`, plus `callbackUrl` when `returnTo` is a safe internal path.
 * An unsafe target omits the param, so sign-in falls through to home.
 */
export function signInHref(returnTo: string | null | undefined): string {
  const safe = safeInternalRedirect(returnTo ?? undefined, '');
  if (!safe) return '/sign-in';
  const url = new URL('/sign-in', BASE);
  url.searchParams.set('callbackUrl', safe);
  return `${url.pathname}${url.search}`;
}

function isSafeInternalPath(target: string, depth: number): boolean {
  if (depth > 5) return false;
  if (hasControlChar(target)) return false;
  if (!target.startsWith('/')) return false;
  if (target.startsWith('//') || target.startsWith('/\\')) return false;
  if (target.includes('\\')) return false;

  const pathPart = target.slice(0, pathEnd(target));
  if (pathPart.includes('://') || pathPart.toLowerCase().includes('javascript:')) return false;

  let parsed: URL;
  try {
    parsed = new URL(target, BASE);
  } catch {
    return false;
  }
  if (parsed.origin !== BASE || parsed.protocol !== 'https:') return false;
  if (parsed.username !== '' || parsed.password !== '') return false;
  if (!parsed.pathname.startsWith('/') || parsed.pathname.startsWith('//')) return false;
  if (SIGN_IN_PATH.test(parsed.pathname)) return false;

  if (!target.includes('%')) return true;
  let decoded: string;
  try {
    decoded = decodeURIComponent(target);
  } catch {
    return false;
  }
  if (decoded === target) return true;
  return isSafeInternalPath(decoded, depth + 1);
}

function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function pathEnd(target: string): number {
  const query = target.indexOf('?');
  const hash = target.indexOf('#');
  if (query === -1) return hash === -1 ? target.length : hash;
  if (hash === -1) return query;
  return Math.min(query, hash);
}
