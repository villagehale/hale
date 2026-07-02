import { encode } from 'next-auth/jwt';

// WHY the salt must equal the Auth.js default session-cookie name:
//
// getToken() (which every mobile-authenticated route reaches, reading the token
// from the `Authorization: Bearer` header) derives its decryption key with
// `salt = cookieName` — @auth/core/jwt.js: `salt = cookieName` default in getToken
// (jwt.js:85) and `getDerivedEncryptionKey(enc, secret, salt)` used by decode
// (jwt.js:69). The cookie name itself is chosen by @auth/core/lib/init.js:
// `defaultCookies(config.useSecureCookies ?? url.protocol === 'https:')`
// (init.js:69) → `${cookiePrefix}authjs.session-token` with cookiePrefix
// `__Secure-` when secure, '' otherwise (cookie.js:44-48). apps/web sets no custom
// cookie config, so the live cookie name — and therefore the read salt — is
// `__Secure-authjs.session-token` behind HTTPS and `authjs.session-token` over
// HTTP. A mobile token must be encrypted under the SAME salt or getToken()
// returns null. This file is the ONE place that pins that mint-side contract; it
// derives the salt from the incoming request's protocol so it always matches the
// read salt on the same deployment.

/** Auth.js default session-cookie name behind HTTPS — doubles as the JWT salt. */
const SECURE_SALT = '__Secure-authjs.session-token';
/** Auth.js default session-cookie name over HTTP — doubles as the JWT salt. */
const INSECURE_SALT = 'authjs.session-token';

/** Mobile session lifetime: 7 days, matching the web JWT session maxAge. */
export const MOBILE_SESSION_MAX_AGE_S = 7 * 24 * 60 * 60;

/**
 * Mint an Auth.js-compatible session JWT for a mobile client. The token is the
 * exact shape getToken() reads from the `Authorization: Bearer` header, so mobile
 * requests authenticate through the same path as web. `secureRequest` picks the
 * salt (= cookie name) that getToken() will use on the same deployment.
 */
export async function mintMobileSessionToken(input: {
  sub: string;
  email: string;
  secureRequest: boolean;
}): Promise<string> {
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    throw new Error('AUTH_SECRET is not set — cannot mint a mobile session token');
  }

  return encode({
    secret,
    salt: input.secureRequest ? SECURE_SALT : INSECURE_SALT,
    maxAge: MOBILE_SESSION_MAX_AGE_S,
    token: { sub: input.sub, email: input.email },
  });
}

/**
 * True iff the request arrived over HTTPS, read from the first value of
 * `x-forwarded-proto` (the proxy-set protocol). Defaults to insecure (false) when
 * the header is absent, matching Auth.js's `url.protocol === 'https:'` default.
 */
export function requestIsSecure(headers: Headers): boolean {
  const proto = headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
  return proto === 'https';
}
