import { errors } from 'jose';
import { NextResponse } from 'next/server';
import { AppleTokenError, verifyAppleIdToken } from '~/lib/auth/apple-id-token';
import { mintMobileSessionToken, requestIsSecure } from '~/lib/auth/mobile-token';
import { authRateLimited } from '~/lib/auth/rate-limit';

export const runtime = 'nodejs';

/**
 * POST /api/mobile/auth/apple — exchange a native Sign in with Apple identity token
 * for a Hale session. verifyAppleIdToken enforces signature + issuer + audience +
 * expiry + nonce; a jose error covers the first four and an AppleTokenError covers
 * the nonce/subject checks. Both map to a single generic 401. Any OTHER throw (a
 * programming bug, e.g. a TypeError) still surfaces as a 500 instead of being
 * disguised as a bad token.
 *
 * The minted session's subject is the Apple account id (the identity token `sub`),
 * mirroring the Google route (auth.config.ts:27-28, token.sub =
 * account.providerAccountId). That id is users.external_auth_id, so a mobile Apple
 * login resolves to the same identity every time. Account provisioning (the
 * users row + family) happens later at onboarding, keyed off this subject — this
 * route never touches the database, exactly like the Google route.
 */
export async function POST(req: Request): Promise<Response> {
  const body = await req.json().catch(() => null);
  const identityToken = typeof body?.identityToken === 'string' ? body.identityToken : '';
  const rawNonce = typeof body?.rawNonce === 'string' ? body.rawNonce : '';
  // The legit client always mints a nonce and binds it into the Apple token, so a
  // nonce-free exchange never comes from us. Requiring rawNonce here removes the
  // "token carries no nonce" acceptance branch entirely — every accepted token is
  // nonce-bound (binds the token to this client; the pair itself stays
  // exchangeable for the token lifetime, bounded by the rate limit).
  if (!identityToken || !rawNonce) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }

  if (await authRateLimited()) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
  }

  let identity: { sub: string; email: string | undefined };
  try {
    identity = await verifyAppleIdToken(identityToken, { rawNonce });
  } catch (err) {
    if (err instanceof errors.JOSEError || err instanceof AppleTokenError) {
      return NextResponse.json({ error: 'invalid_token' }, { status: 401 });
    }
    throw err;
  }

  const token = await mintMobileSessionToken({
    sub: identity.sub,
    email: identity.email,
    secureRequest: requestIsSecure(req.headers),
  });
  return NextResponse.json({ token }, { status: 200 });
}
