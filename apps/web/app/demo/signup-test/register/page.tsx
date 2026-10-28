import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import {
  SIGNUP_TEST_ACTIVITY,
  SIGNUP_TEST_FORM_PATH,
  SIGNUP_TEST_SESSIONS,
  SIGNUP_TEST_SESSION_COOKIE,
  signupTestFormEnabled,
} from '~/lib/signup/test-form';
import { HarborButton, HarborField, HarborShell } from '../harbor';

export const dynamic = 'force-dynamic';

export default async function SignupTestRegisterPage() {
  if (!signupTestFormEnabled()) notFound();
  const jar = await cookies();
  if (jar.get(SIGNUP_TEST_SESSION_COOKIE)?.value !== 'signed-in') {
    redirect(`${SIGNUP_TEST_FORM_PATH}/login`);
  }
  return (
    <HarborShell title={SIGNUP_TEST_ACTIVITY}>
      <p data-price-cents="4000">40.00 CAD</p>
      <form method="post" action="/api/demo/signup-test/register">
        <HarborField label="Child first name" name="child_first_name" />
        <HarborField label="Parent email" name="parent_email" type="email" />
        <HarborField label="Postal code" name="postal_code" />
        <HarborField label="Session" name="session">
          <select name="session" required style={{ width: '100%', padding: '8px 10px', fontSize: 16 }}>
            <option value="">Choose</option>
            {SIGNUP_TEST_SESSIONS.map((session) => (
              <option key={session.id} value={session.id}>
                {session.label}
              </option>
            ))}
          </select>
        </HarborField>
        <HarborButton>Continue to checkout</HarborButton>
      </form>
    </HarborShell>
  );
}
