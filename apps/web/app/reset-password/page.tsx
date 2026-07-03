import Link from 'next/link';
import { AuthShell } from '~/components/hale/auth-shell';
import { ResetPasswordForm } from '~/components/hale/reset-password-form';
import { credentialsConfigured } from '~/lib/auth-config';

export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: Promise<{ token?: string }>;
}

/**
 * Set-a-new-password landing for /reset-password?token=…. The token is validated
 * (single-use, expiring, hashed at rest) only when the form is SUBMITTED, in the
 * server action — this page render never consumes it, so a link-prefetch can't
 * spend the token. A missing token shows a calm path back to request a fresh one.
 */
export default async function ResetPasswordPage({ searchParams }: PageProps) {
  const { token } = await searchParams;

  if (!credentialsConfigured()) {
    return (
      <AuthShell heading="Choose a new password">
        <p className="meta">Password reset isn&rsquo;t available in this preview.</p>
      </AuthShell>
    );
  }

  if (!token) {
    return (
      <AuthShell heading="Choose a new password">
        <p className="meta">
          This reset link is missing or incomplete. Request a fresh one and try again.
        </p>
        <Link href="/forgot-password" className="btn-primary self-start">
          Request a new link
        </Link>
      </AuthShell>
    );
  }

  return (
    <AuthShell heading="Choose a new password">
      <ResetPasswordForm token={token} />
      <Link href="/forgot-password" className="btn-ghost self-start">
        Need a new link? Start over &rarr;
      </Link>
    </AuthShell>
  );
}
