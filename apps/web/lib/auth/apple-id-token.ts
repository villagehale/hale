import { createHash, timingSafeEqual } from 'node:crypto';
import { type JWTVerifyGetKey, createRemoteJWKSet, jwtVerify } from 'jose';

// Verifies an Apple-issued identity token (the credential expo-apple-authentication
// returns from signInAsync) so the mobile /api/mobile/auth/apple route can exchange
// it for a Hale session. Security-critical: a forged, misdirected, or replayed
// identity token must NEVER pass. jwtVerify checks the RS256 signature against
// Apple's published JWKS AND enforces issuer + audience + expiry; a failure on any
// of those throws a jose error, which the route maps to 401. We additionally verify
// the nonce (binds the token to the requesting client — not a one-time-use
// guarantee; the nonce is client-minted) and never fall back to trusting the
// token's own claims.

const APPLE_ISSUER = 'https://appleid.apple.com';
const APPLE_JWKS_URL = new URL('https://appleid.apple.com/auth/keys');

// Lazily created so importing this module never opens a network handle, and so
// tests can inject a local JWKS instead. Apple rotates its keys, so the remote set
// caches and refreshes them on its own.
let remoteJwks: JWTVerifyGetKey | undefined;
function appleJwks(): JWTVerifyGetKey {
  if (!remoteJwks) {
    remoteJwks = createRemoteJWKSet(APPLE_JWKS_URL);
  }
  return remoteJwks;
}

// Apple issues native identity tokens with audience = the app's bundle id (NOT an
// OAuth client id like Google), so this verifier keeps its own audience source
// rather than sharing configuredAudiences() with the Google verifier.
function configuredAudiences(): string[] {
  return [process.env.APPLE_APP_BUNDLE_ID].filter((id): id is string => Boolean(id));
}

/** SHA-256 hex of the raw nonce — the value Apple echoes into the token's `nonce`
 * claim. The client hashes its random nonce before handing it to signInAsync and
 * sends the raw nonce to the server; we recompute the hash here to match. */
function hashNonce(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

function nonceMatches(expectedHash: string, tokenNonce: unknown): boolean {
  if (typeof tokenNonce !== 'string') {
    return false;
  }
  const a = Buffer.from(expectedHash);
  const b = Buffer.from(tokenNonce);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * A verification failure that is NOT a jose signature/issuer/audience/expiry error
 * — a nonce mismatch or a missing subject. The route maps both this and jose's
 * error hierarchy to a single 401, while any other throw (a real bug) still bubbles
 * to a 500 rather than being disguised as a bad token.
 */
export class AppleTokenError extends Error {}

export interface AppleIdentity {
  sub: string;
  email: string | undefined;
}

/**
 * Verify an Apple identity token and return its subject + email. Throws a jose
 * error on any verification failure (bad signature, wrong issuer/audience, or
 * expiry) and an Error on a nonce mismatch — the route maps all of these to 401.
 * `jwks` is injectable so tests verify against a local keypair without hitting the
 * network; production uses Apple's remote JWKS.
 *
 * `rawNonce` is the un-hashed nonce the client generated; when the token carries a
 * `nonce` claim it MUST equal SHA-256(rawNonce). A token bound to a nonce is never
 * accepted unbound, and a supplied nonce with no claim is rejected — the token is
 * bound to the client that minted the nonce (not a one-time-use guarantee).
 */
export async function verifyAppleIdToken(
  identityToken: string,
  input: { rawNonce?: string },
  deps: { jwks?: JWTVerifyGetKey } = {},
): Promise<AppleIdentity> {
  const audience = configuredAudiences();
  // Fail closed: an empty audience allow-list would make jwtVerify skip the aud
  // check and accept a token minted for any other app. Refuse to verify instead.
  if (audience.length === 0) {
    throw new Error('No Apple app bundle id configured — cannot verify identity token');
  }

  const { payload } = await jwtVerify(identityToken, deps.jwks ?? appleJwks(), {
    issuer: APPLE_ISSUER,
    audience,
    algorithms: ['RS256'],
  });

  // Replay defense. Both directions must fail closed: a client-supplied nonce
  // requires a matching claim, and a token that carries a nonce claim must not be
  // accepted when no nonce was supplied to check it.
  if (input.rawNonce !== undefined) {
    if (!nonceMatches(hashNonce(input.rawNonce), payload.nonce)) {
      throw new AppleTokenError('Apple identity token nonce mismatch');
    }
  } else if (payload.nonce !== undefined) {
    throw new AppleTokenError(
      'Apple identity token carries a nonce but none was supplied to verify it',
    );
  }

  const sub = payload.sub;
  if (!sub) {
    throw new AppleTokenError('Apple identity token has no subject');
  }
  // Only trust the email when Apple asserts it's verified. Apple encodes
  // email_verified as either a boolean or the string "true"/"false", so accept
  // both truthy forms; anything else drops the email rather than resolving an
  // identity off an unverified address.
  const verified = payload.email_verified === true || payload.email_verified === 'true';
  const email =
    verified && typeof payload.email === 'string' ? payload.email : undefined;
  return { sub, email };
}
