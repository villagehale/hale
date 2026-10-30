import { notFound } from 'next/navigation';
import {
  SIGNUP_TEST_ACTIVITY,
  SIGNUP_TEST_FORM_PATH,
  SIGNUP_TEST_PRICE_CENTS,
  signupTestFormEnabled,
} from '~/lib/signup/test-form';
import { HarborButton, HarborShell } from './harbor';

export const dynamic = 'force-dynamic';

/**
 * Preview-only Harbor Rec landing. Production 404s via the demo layout and
 * this gate. Browser Use starts here, then signs in.
 */
export default function SignupTestLandingPage() {
  if (!signupTestFormEnabled()) notFound();
  const dollars = (SIGNUP_TEST_PRICE_CENTS / 100).toFixed(2);
  return (
    <HarborShell title="Fall classes">
      <p>
        {SIGNUP_TEST_ACTIVITY} is open. {dollars} CAD. Sign in with your rec account, pick a
        session, and pay at checkout.
      </p>
      <form method="get" action={`${SIGNUP_TEST_FORM_PATH}/login`}>
        <HarborButton>Sign in</HarborButton>
      </form>
    </HarborShell>
  );
}
