import type { Metadata } from 'next';
import Link from 'next/link';
import { AuthShell } from '~/components/hale/auth-shell';
import stage from '~/components/hale/connect/connect.module.css';
import { ForgotPasswordForm } from '~/components/hale/forgot-password-form';
import door from '~/components/portal/signin.module.css';
import { credentialsConfigured } from '~/lib/auth-config';

export const metadata: Metadata = { title: 'Reset password' };

// AUTH_SECRET is runtime-only (see /sign-up), so evaluate configuredness at request
// time rather than caching a build-time "not configured" fallback.
export const dynamic = 'force-dynamic';

export default function ForgotPasswordPage() {
  if (!credentialsConfigured()) {
    return (
      <AuthShell heading="Reset your password">
        <p className={stage.lede}>
          Password reset isn&rsquo;t available in this preview — email sign-in isn&rsquo;t
          configured here.
        </p>
      </AuthShell>
    );
  }

  return (
    <AuthShell heading="Reset your password">
      <ForgotPasswordForm />
      <p className={door.new}>
        <Link href="/sign-in">Remembered it? Back to sign in &rarr;</Link>
      </p>
    </AuthShell>
  );
}
