import { notFound } from 'next/navigation';
import { signupTestFormEnabled } from '~/lib/signup/test-form';
import { HarborButton, HarborField, HarborShell } from '../harbor';

export const dynamic = 'force-dynamic';

export default function SignupTestLoginPage() {
  if (!signupTestFormEnabled()) notFound();
  return (
    <HarborShell title="Sign in">
      <form method="post" action="/api/demo/signup-test/login">
        <HarborField label="Email" name="email" type="email" autoComplete="username" />
        <HarborField
          label="Password"
          name="password"
          type="password"
          autoComplete="current-password"
        />
        <HarborButton>Sign in</HarborButton>
      </form>
    </HarborShell>
  );
}
