import { type JWTVerifyGetKey, createRemoteJWKSet, jwtVerify } from 'jose';

// Verifies a Google-issued id_token (the credential the native Google Sign-In
// SDK returns) so the mobile /api/mobile/auth/google route can exchange it for a
// Hale session. This is security-critical: a forged or misdirected id_token must
// NEVER pass. jwtVerify checks the RS256 signature against Google's published
// JWKS AND enforces issuer + audience + expiry; a failure on any of those throws
// a jose error, which the route maps to 401. We never fall back to trusting the
// token's own claims.

const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
const GOOGLE_JWKS_URL = new URL('https://www.googleapis.com/oauth2/v3/certs');

// Lazily created so importing this module never opens a network handle, and so
// tests can inject a local JWKS instead. Google rotates its keys, so the remote
// set caches and refreshes them on its own.
let remoteJwks: JWTVerifyGetKey | undefined;
function googleJwks(): JWTVerifyGetKey {
  if (!remoteJwks) {
    remoteJwks = createRemoteJWKSet(GOOGLE_JWKS_URL);
  }
  return remoteJwks;
}

/** Every Google OAuth client id this deployment accepts an id_token for: the web
 * client id and (when the native app is wired) the iOS client id. */
function configuredAudiences(): string[] {
  return [process.env.GOOGLE_OAUTH_CLIENT_ID, process.env.GOOGLE_OAUTH_IOS_CLIENT_ID].filter(
    (id): id is string => Boolean(id),
  );
}

export interface GoogleIdentity {
  sub: string;
  email: string | undefined;
}

/**
 * Verify a Google id_token and return its subject + email. Throws a jose error on
 * any verification failure (bad signature, wrong issuer/audience, or expiry).
 * `jwks` is injectable so tests verify against a local keypair without hitting
 * the network; production uses Google's remote JWKS.
 */
export async function verifyGoogleIdToken(
  idToken: string,
  deps: { jwks?: JWTVerifyGetKey } = {},
): Promise<GoogleIdentity> {
  const audience = configuredAudiences();
  // Fail closed: an empty audience allow-list would make jwtVerify skip the aud
  // check and accept a token minted for any other app. Refuse to verify instead.
  if (audience.length === 0) {
    throw new Error('No Google OAuth client id configured — cannot verify id_token');
  }

  const { payload } = await jwtVerify(idToken, deps.jwks ?? googleJwks(), {
    issuer: GOOGLE_ISSUERS,
    audience,
  });

  const sub = payload.sub;
  if (!sub) {
    throw new Error('Google id_token has no subject');
  }
  const email = typeof payload.email === 'string' ? payload.email : undefined;
  return { sub, email };
}
