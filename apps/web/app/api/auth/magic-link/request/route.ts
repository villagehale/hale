import { NextResponse } from 'next/server';
import { authConfigured } from '~/lib/auth-config';
import { requestMagicLink } from '~/lib/auth/magic-link';
import { authRateLimited } from '~/lib/auth/rate-limit';
import { safeInternalRedirect } from '~/lib/auth/redirect';
import { createVerificationEmailSender } from '~/lib/auth/verification-email';
import { db } from '~/lib/db';

export const runtime = 'nodejs';

const APP_BASE = process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.villagehale.com';

/**
 * POST /api/auth/magic-link/request { email } — mail a passwordless sign-in link
 * for the WEB app. The link lands on /magic-link?token=…, which redeems the token
 * and mints the session. Works for both sign-in and first-time sign-up, so it mints
 * for ANY valid address; web onboarding can authenticate mid-flow through it.
 *
 * ALWAYS returns the SAME 200 body whether or not the account exists (rule #1 —
 * account-enumeration defense). Per-IP rate-limited against link-spam. The send is
 * fire-and-forget so a Resend outage never fails the request (boundary catch, #8);
 * because a link is mailed for every valid address regardless of account existence,
 * that also means latency carries no existence signal.
 */
export async function POST(req: Request): Promise<Response> {
  if (!authConfigured()) {
    return NextResponse.json({ error: 'unavailable' }, { status: 503 });
  }

  const body = (await req.json().catch(() => null)) as {
    email?: string;
    callbackUrl?: string;
  } | null;
  const email = typeof body?.email === 'string' ? body.email : '';
  const callbackUrl =
    typeof body?.callbackUrl === 'string' ? safeInternalRedirect(body.callbackUrl, '') : '';
  if (!email) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }

  if (await authRateLimited()) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
  }

  const result = await requestMagicLink(email, db());
  if (result.token) {
    const magicUrl = new URL('/magic-link', APP_BASE);
    magicUrl.searchParams.set('token', result.token);
    if (callbackUrl) magicUrl.searchParams.set('callbackUrl', callbackUrl);
    void createVerificationEmailSender()
      .sendMagicLink(result.email, magicUrl.toString())
      .catch((err) => {
        const message = err instanceof Error ? err.message : 'unknown error';
        console.error('magic-link email failed (response unaffected)', { message });
      });
  }

  // Identical outcome whether or not a token was minted.
  return NextResponse.json({ status: 'sent' });
}
