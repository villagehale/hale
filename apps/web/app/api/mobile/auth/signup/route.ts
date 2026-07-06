import { NextResponse } from 'next/server';
import { authConfigured } from '~/lib/auth-config';
import { registerCredential } from '~/lib/auth/credentials';
import { authRateLimited } from '~/lib/auth/rate-limit';
import { dispatchSignupSideEffects } from '~/lib/auth/signup-side-effects';
import { defaultSignupSideEffectDeps } from '~/lib/auth/signup-side-effects.wiring';
import { db } from '~/lib/db';

export const runtime = 'nodejs';

const APP_BASE = process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.villagehale.com';

/**
 * POST /api/mobile/auth/signup — native email+password sign-up. The native
 * counterpart to the web signUpAction (server actions aren't mobile-callable):
 * registerCredential + fire the verification email, then return `check_email`.
 *
 * Verification is required (requireEmailVerification default true), so this route
 * NEVER mints a session — the app tells the user to confirm their email, then they
 * sign in via /api/mobile/auth/password (which enforces requireVerified). Google
 * sign-up (already verified) uses /api/mobile/auth/google instead.
 *
 * Account-enumeration defense (rule #1): an already-registered email returns the
 * SAME `check_email` as a fresh sign-up, and the verification email is fired
 * fire-and-forget so response latency can't tell the two apart.
 */
export async function POST(req: Request): Promise<Response> {
  if (!authConfigured()) {
    return NextResponse.json({ error: 'unavailable' }, { status: 503 });
  }

  const body = (await req.json().catch(() => null)) as {
    email?: string;
    password?: string;
  } | null;
  const email = typeof body?.email === 'string' ? body.email : '';
  const password = typeof body?.password === 'string' ? body.password : '';
  if (!email || !password) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }

  if (await authRateLimited()) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
  }

  const database = db();
  const result = await registerCredential(email, password, database);
  if (!result.ok) {
    if (result.error === 'invalid_email') {
      return NextResponse.json({ error: 'invalid_email' }, { status: 400 });
    }
    if (result.error === 'weak_password') {
      return NextResponse.json({ error: 'weak_password' }, { status: 400 });
    }
    // email_taken: indistinguishable from a fresh sign-up (enumeration defense).
    return NextResponse.json({ status: 'check_email' });
  }

  const verifyUrl = `${APP_BASE}/verify?token=${encodeURIComponent(result.verificationToken)}`;
  void dispatchSignupSideEffects(
    { db: database, email: result.email, verifyUrl },
    defaultSignupSideEffectDeps(database, result.credentialId, result.email),
  );
  return NextResponse.json({ status: 'check_email' });
}
