import { NextResponse } from 'next/server';
import {
  SIGNUP_TEST_CART_COOKIE,
  SIGNUP_TEST_FORM_PATH,
  SIGNUP_TEST_SESSION_COOKIE,
  signupTestFormEnabled,
  signupTestSession,
} from '~/lib/signup/test-form';

export const runtime = 'nodejs';

/**
 * POST /api/demo/signup-test/register — put one session in the Harbor Rec cart
 * and send the browser to checkout. Production 404s. No payment is taken.
 */
export async function POST(req: Request): Promise<Response> {
  if (!signupTestFormEnabled()) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  const origin = new URL(req.url).origin;
  const signedIn = req.headers
    .get('cookie')
    ?.split(';')
    .some((part) => part.trim().startsWith(`${SIGNUP_TEST_SESSION_COOKIE}=signed-in`));
  if (!signedIn) {
    return NextResponse.redirect(new URL(`${SIGNUP_TEST_FORM_PATH}/login`, origin), 303);
  }
  const form = await req.formData().catch(() => null);
  const childFirstName = String(form?.get('child_first_name') ?? '').trim();
  const parentEmail = String(form?.get('parent_email') ?? '').trim();
  const postalCode = String(form?.get('postal_code') ?? '').trim();
  const sessionId = String(form?.get('session') ?? '').trim();
  if (!childFirstName || !parentEmail || !postalCode || !signupTestSession(sessionId)) {
    return NextResponse.redirect(new URL(`${SIGNUP_TEST_FORM_PATH}/register?err=1`, origin), 303);
  }
  const response = NextResponse.redirect(new URL(`${SIGNUP_TEST_FORM_PATH}/checkout`, origin), 303);
  response.cookies.set(
    SIGNUP_TEST_CART_COOKIE,
    JSON.stringify({ childFirstName, parentEmail, postalCode, sessionId }),
    {
      httpOnly: true,
      sameSite: 'lax',
      secure: origin.startsWith('https:'),
      path: '/',
    },
  );
  return response;
}
