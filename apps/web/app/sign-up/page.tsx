import Link from 'next/link';
import { signIn } from '~/auth';
import { AuthShell } from '~/components/hale/auth-shell';
import { EmailSignUpForm } from '~/components/hale/email-sign-up-form';
import { credentialsConfigured, googleConfigured } from '~/lib/auth-config';

// AUTH_SECRET is a runtime-only secret (not in the build env), so render at
// request time — otherwise credentialsConfigured() is evaluated at build with
// no secret and the page caches the "not configured" fallback.
export const dynamic = 'force-dynamic';

export default function SignUpPage() {
  const google = googleConfigured();
  const credentials = credentialsConfigured();

  if (!google && !credentials) {
    return (
      <AuthShell heading="Join the village">
        <p className="meta">Sign-up isn&rsquo;t available in this preview yet.</p>
      </AuthShell>
    );
  }

  return (
    <AuthShell heading="Join the village">
      {google ? (
        <form
          action={async () => {
            'use server';
            // Google provisions a first-time account; a fresh account has no
            // family yet, so onboarding starts at intake (Phase A).
            await signIn('google', { redirectTo: '/onboarding' });
          }}
        >
          <button type="submit" className="btn-primary w-full">
            Continue with Google
          </button>
        </form>
      ) : null}

      {google && credentials ? (
        <div className="flex items-center gap-3">
          <span className="h-px flex-1 bg-spruce/15" />
          <span className="meta">or with email</span>
          <span className="h-px flex-1 bg-spruce/15" />
        </div>
      ) : null}

      {credentials ? <EmailSignUpForm /> : null}

      <p className="meta">
        By creating an account you agree to our{' '}
        <Link href="/terms" className="link">
          Terms
        </Link>{' '}
        and{' '}
        <Link href="/privacy" className="link">
          Privacy Policy
        </Link>
        .
      </p>

      <Link href="/sign-in" className="btn-ghost self-start">
        Already have an account? Sign in &rarr;
      </Link>
    </AuthShell>
  );
}
