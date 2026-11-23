import { notFound } from 'next/navigation';
import {
  SIGNUP_TEST_ACTIVITY,
  SIGNUP_TEST_PRICE_CENTS,
  signupTestFormEnabled,
} from '~/lib/signup/test-form';
import { HarborShell } from '../harbor';

export const dynamic = 'force-dynamic';

/**
 * VIL-715 · a fake confirmation page for the receipt masker's Preview proof. Every value is
 * invented, and the card and password lines are what the mask must take off the image.
 * Production does not serve it.
 */
export default function SignupTestConfirmedPage() {
  if (!signupTestFormEnabled()) notFound();
  const dollars = (SIGNUP_TEST_PRICE_CENTS / 100).toFixed(2);
  return (
    <HarborShell title="Registration confirmed">
      <p>
        Confirmation number <strong>HR-20417</strong>
      </p>
      <p>
        Class: <span>{SIGNUP_TEST_ACTIVITY}</span>
      </p>
      <p>
        Total charged: <span>${dollars}</span>
      </p>
      <p>Paid with Visa 4242 4242 4242 4242, expires 09/29</p>
      <p>Your temporary password is harbor-demo-password</p>
    </HarborShell>
  );
}
