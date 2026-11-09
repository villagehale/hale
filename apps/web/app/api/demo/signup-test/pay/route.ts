import { NextResponse } from 'next/server';
import { SIGNUP_TEST_FORM_PATH, signupTestFormEnabled } from '~/lib/signup/test-form';

export const runtime = 'nodejs';

/**
 * POST /api/demo/signup-test/pay — the checkout Pay button lands here.
 * This form never charges. Production 404s. Browser Use must not submit it.
 */
export async function POST(req: Request): Promise<Response> {
  if (!signupTestFormEnabled()) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  const origin = new URL(req.url).origin;
  return NextResponse.redirect(new URL(`${SIGNUP_TEST_FORM_PATH}/checkout?held=1`, origin), 303);
}
