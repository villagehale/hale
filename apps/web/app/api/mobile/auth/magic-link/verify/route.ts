import { NextResponse } from 'next/server';
import { consumeMagicLinkToken } from '~/lib/auth/magic-link';
import { mintMobileSessionToken, requestIsSecure } from '~/lib/auth/mobile-token';
import { authRateLimited } from '~/lib/auth/rate-limit';
import { db } from '~/lib/db';

export const runtime = 'nodejs';

/**
 * POST /api/mobile/auth/magic-link/verify { token } — redeem a magic link on the
 * native app. Mirrors /api/mobile/auth/password: rate-limit, then the SAME token
 * consume the web magic-link provider uses (validate + atomic single-use +
 * find-or-create), then mint the Auth.js-compatible session JWT the app carries as
 * a Bearer token. On success returns { token: <bearer> }, exactly the password
 * route's shape.
 *
 * A token that is unknown / expired / already consumed returns ONE generic error,
 * never revealing which. The token is never logged.
 */
export async function POST(req: Request): Promise<Response> {
  const body = await req.json().catch(() => null);
  const token = typeof body?.token === 'string' ? body.token : '';
  if (!token) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }

  if (await authRateLimited()) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
  }

  const result = await consumeMagicLinkToken(token, db());
  if (!result.ok) {
    return NextResponse.json({ error: 'invalid_token' }, { status: 401 });
  }

  const bearer = await mintMobileSessionToken({
    sub: result.identity.id,
    email: result.identity.email,
    secureRequest: requestIsSecure(req.headers),
  });
  return NextResponse.json({ token: bearer }, { status: 200 });
}
