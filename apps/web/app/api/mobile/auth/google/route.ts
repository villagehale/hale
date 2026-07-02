import { errors } from 'jose';
import { NextResponse } from 'next/server';
import { verifyGoogleIdToken } from '~/lib/auth/google-id-token';
import { mintMobileSessionToken, requestIsSecure } from '~/lib/auth/mobile-token';
import { authRateLimited } from '~/lib/auth/rate-limit';

export const runtime = 'nodejs';

/**
 * POST /api/mobile/auth/google — exchange a native Google Sign-In id_token for a
 * Hale session. verifyGoogleIdToken enforces signature + issuer + audience +
 * expiry; ANY of those failing throws a jose error, which we map to a single
 * generic 401. We catch only jose's error hierarchy (errors.JOSEError) so a
 * programming bug (e.g. a TypeError) still surfaces as a 500 instead of being
 * disguised as a bad token.
 *
 * The minted session's subject is the Google account id (the id_token `sub`),
 * matching the web JWT callback (auth.config.ts:27-28) where token.sub =
 * account.providerAccountId. That id is users.external_auth_id, so a mobile
 * Google login resolves to the same identity as a web one.
 */
export async function POST(req: Request): Promise<Response> {
  const body = await req.json().catch(() => null);
  const idToken = typeof body?.idToken === 'string' ? body.idToken : '';
  if (!idToken) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }

  if (await authRateLimited()) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
  }

  let identity: { sub: string; email: string | undefined };
  try {
    identity = await verifyGoogleIdToken(idToken);
  } catch (err) {
    if (err instanceof errors.JOSEError) {
      return NextResponse.json({ error: 'invalid_token' }, { status: 401 });
    }
    throw err;
  }

  const token = await mintMobileSessionToken({
    sub: identity.sub,
    email: identity.email ?? '',
    secureRequest: requestIsSecure(req.headers),
  });
  return NextResponse.json({ token }, { status: 200 });
}
