import { NextResponse } from 'next/server';
import { authConfigured } from '~/lib/auth-config';
import { requestMagicLink } from '~/lib/auth/magic-link';
import { authRateLimited } from '~/lib/auth/rate-limit';
import { createVerificationEmailSender } from '~/lib/auth/verification-email';
import { db } from '~/lib/db';

export const runtime = 'nodejs';

const APP_BASE = process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.villagehale.com';

/**
 * POST /api/mobile/auth/magic-link/request { email } — the native counterpart to
 * the web magic-link request. Same enumeration-safe semantics (ALWAYS the same 200
 * body, per-IP rate-limited, mints for any valid address), but the link lands on
 * /m/magic?token=… — a web page that hands off into the app via its deep-link
 * scheme — instead of the web /magic-link redeem page.
 */
export async function POST(req: Request): Promise<Response> {
  if (!authConfigured()) {
    return NextResponse.json({ error: 'unavailable' }, { status: 503 });
  }

  const body = (await req.json().catch(() => null)) as { email?: string } | null;
  const email = typeof body?.email === 'string' ? body.email : '';
  if (!email) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }

  if (await authRateLimited()) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
  }

  const result = await requestMagicLink(email, db());
  if (result.token) {
    const magicUrl = `${APP_BASE}/m/magic?token=${encodeURIComponent(result.token)}`;
    void createVerificationEmailSender()
      .sendMagicLink(result.email, magicUrl)
      .catch((err) => {
        const message = err instanceof Error ? err.message : 'unknown error';
        console.error('mobile magic-link email failed (response unaffected)', { message });
      });
  }

  return NextResponse.json({ status: 'sent' });
}
