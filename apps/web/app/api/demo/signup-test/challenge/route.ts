import { NextResponse } from 'next/server';
import {
  SIGNUP_TEST_CHALLENGE_COOKIE,
  SIGNUP_TEST_FORM_PATH,
  signupTestChallenge,
  signupTestChallengePassed,
  signupTestFormEnabled,
} from '~/lib/signup/test-form';

export const runtime = 'nodejs';

/**
 * POST /api/demo/signup-test/challenge — VIL-718. The fake Harbor Rec step for the takeover
 * link's Preview runs. A right answer marks the step passed and goes on to the form; a wrong
 * one (and every passkey: there is none on this browser) comes back to the step. Production
 * 404s.
 */
export async function POST(req: Request): Promise<Response> {
  if (!signupTestFormEnabled()) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  const form = await req.formData().catch(() => null);
  const kind = signupTestChallenge(String(form?.get('kind') ?? ''));
  const origin = new URL(req.url).origin;
  if (!kind) return NextResponse.redirect(new URL(SIGNUP_TEST_FORM_PATH, origin), 303);
  const answer = String(form?.get('answer') ?? '');
  if (!signupTestChallengePassed(kind, answer)) {
    return NextResponse.redirect(
      new URL(`${SIGNUP_TEST_FORM_PATH}/challenge?kind=${kind}&err=1`, origin),
      303,
    );
  }
  const response = NextResponse.redirect(new URL(`${SIGNUP_TEST_FORM_PATH}/register`, origin), 303);
  response.cookies.set(SIGNUP_TEST_CHALLENGE_COOKIE, 'passed', {
    httpOnly: true,
    sameSite: 'lax',
    secure: origin.startsWith('https:'),
    path: '/',
  });
  return response;
}
