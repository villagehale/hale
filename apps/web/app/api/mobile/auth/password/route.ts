import { NextResponse } from 'next/server';
import { authenticateCredential } from '~/lib/auth/credentials';
import {
  mintMobileSessionToken,
  requestIsSecure,
} from '~/lib/auth/mobile-token';
import { authRateLimited } from '~/lib/auth/rate-limit';
import { requireEmailVerification } from '~/lib/auth-config';
import { db } from '~/lib/db';

export const runtime = 'nodejs';

/**
 * POST /api/mobile/auth/password — email+password sign-in for the native app.
 *
 * The credential check is the EXACT chokepoint web uses (auth.ts authorize):
 * authRateLimited() then authenticateCredential(..., { requireVerified }). No new
 * password logic lives here. On success we mint an Auth.js-compatible session JWT
 * (the same one web sets as a cookie) and hand it back for the app to carry as a
 * Bearer token; getToken() reads it on every subsequent mobile request.
 *
 * Every failure — malformed body, wrong password, unverified email — returns ONE
 * generic error that never reveals which field was wrong or whether the account
 * exists (account-enumeration defense, matching authorize). Email and password
 * are never logged.
 */
export async function POST(req: Request): Promise<Response> {
  const body = await req.json().catch(() => null);
  const email = typeof body?.email === 'string' ? body.email : '';
  const password = typeof body?.password === 'string' ? body.password : '';
  if (!email || !password) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }

  if (await authRateLimited()) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
  }

  const identity = await authenticateCredential(email, password, db(), {
    requireVerified: requireEmailVerification(),
  });
  if (!identity) {
    return NextResponse.json({ error: 'invalid_credentials' }, { status: 401 });
  }

  const token = await mintMobileSessionToken({
    sub: identity.id,
    email: identity.email,
    secureRequest: requestIsSecure(req.headers),
  });
  return NextResponse.json({ token }, { status: 200 });
}
