import Link from 'next/link';
import { AuthShell } from '~/components/hale/auth-shell';
import { ForgotPasswordForm } from '~/components/hale/forgot-password-form';
import { credentialsConfigured } from '~/lib/auth-config';

// AUTH_SECRET is runtime-only (see /sign-up), so evaluate configuredness at request
// time rather than caching a build-time "not configured" fallback.
export const dynamic = 'force-dynamic';

export default function ForgotPasswordPage() {
  if (!credentialsConfigured()) {
    return (
      <AuthShell heading="Reset your password">
        <p className="meta">
          Password reset isn&rsquo;t available in this preview — email sign-in isn&rsquo;t configured
          here.
        </p>
      </AuthShell>
    );
  }

  return (
    <AuthShell heading="Reset your password">
      <ForgotPasswordForm />
      <Link href="/sign-in" className="btn-ghost self-start">
        Remembered it? Back to sign in &rarr;
      </Link>
    </AuthShell>
  );
}
