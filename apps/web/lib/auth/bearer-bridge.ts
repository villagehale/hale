// Edge-safe (pure functions, no Node-only imports): this runs inside the Edge
// middleware. The middleware rewrites REQUEST headers so a mobile client's
// `Authorization: Bearer <token>` becomes the Auth.js session cookie that every
// downstream `await auth()` already reads — mobile authenticates through the
// unchanged web path. getToken() reads a Bearer directly, but auth()'s
// getSession() rebuilds the request copying ONLY the cookie header, so the bridge
// is what makes the SESSION-based server loaders/routes see a mobile token.

const SECURE_COOKIE_NAME = '__Secure-authjs.session-token';
const INSECURE_COOKIE_NAME = 'authjs.session-token';

// JWE compact serialization charset (five base64url segments joined by dots).
// Anything else — whitespace, ';', CR/LF — is rejected so a token can neither
// inject a second cookie nor a new header when composed into the Cookie header.
const JWE_COMPACT = /^[A-Za-z0-9_.-]+$/;

/** True iff `cookieHeader` already sets a cookie literally named `name`. */
function hasCookie(cookieHeader: string, name: string): boolean {
  return cookieHeader.split(';').some((pair) => pair.slice(0, pair.indexOf('=')).trim() === name);
}

/**
 * Bridge a mobile `Authorization: Bearer <token>` into the Auth.js session-cookie
 * header value, or null when the request must be left untouched. Returns a value
 * only when ALL hold: the path is under `/api/`; the Authorization header is
 * exactly `Bearer <token>`; the token is JWE-compact charset (so it can't inject
 * a cookie/header); and the request does NOT already carry the session cookie
 * (a browser session always wins). The result APPENDS the session cookie to any
 * existing Cookie header, preserving the caller's other cookies.
 */
export function bridgeBearerToSessionCookie(req: {
  headers: Headers;
  pathname: string;
  secure: boolean;
}): { cookieHeader: string } | null {
  if (!req.pathname.startsWith('/api/')) return null;

  const authorization = req.headers.get('authorization');
  if (!authorization) return null;

  const [scheme, token, ...rest] = authorization.split(' ');
  if (scheme !== 'Bearer' || token === undefined || rest.length > 0) return null;
  if (!JWE_COMPACT.test(token)) return null;

  const cookieName = req.secure ? SECURE_COOKIE_NAME : INSECURE_COOKIE_NAME;

  const existing = req.headers.get('cookie');
  if (existing && hasCookie(existing, cookieName)) return null;

  const sessionCookie = `${cookieName}=${token}`;
  return { cookieHeader: existing ? `${existing}; ${sessionCookie}` : sessionCookie };
}
