import { NextResponse } from 'next/server';
import {
  SIGNUP_TEST_FORM_PATH,
  SIGNUP_TEST_SESSION_COOKIE,
  signupTestFormEnabled,
} from '~/lib/signup/test-form';

export const runtime = 'nodejs';

/**
 * POST /api/demo/signup-test/login — fake Harbor Rec sign-in for the Preview
 * test form. Any non-empty email and password sets the session cookie.
 * Production 404s.
 */
export async function POST(req: Request): Promise<Response> {
  if (!signupTestFormEnabled()) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  const form = await req.formData().catch(() => null);
  const email = String(form?.get('email') ?? '').trim();
  const password = String(form?.get('password') ?? '');
  const origin = new URL(req.url).origin;
  if (!email || !password) {
    return NextResponse.redirect(new URL(`${SIGNUP_TEST_FORM_PATH}/login?err=1`, origin), 303);
  }
  const response = NextResponse.redirect(new URL(`${SIGNUP_TEST_FORM_PATH}/register`, origin), 303);
  response.cookies.set(SIGNUP_TEST_SESSION_COOKIE, 'signed-in', {
    httpOnly: true,
    sameSite: 'lax',
    secure: origin.startsWith('https:'),
    path: '/',
  });
  return response;
}
