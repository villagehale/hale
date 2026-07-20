import Link from 'next/link';
import { signIn } from '~/auth';
import { AuthShell } from '~/components/hale/auth-shell';
import { MagicLinkRequestForm } from '~/components/hale/magic-link-request-form';
import { credentialsConfigured, googleConfigured } from '~/lib/auth-config';

// AUTH_SECRET is a runtime-only secret (not in the build env), so render at
// request time — otherwise configuredness is evaluated at build with no secret and
// the page caches the "not configured" fallback.
export const dynamic = 'force-dynamic';

/**
 * Web sign-up — Google + a passwordless magic link only (locked auth decision: no
 * password UI, no Apple on web). Google provisions a first-time account with no
 * family, so it lands in onboarding; the magic link mints for any address (it is
 * the same request the sign-in page uses) and its redeem lands the new parent in
 * onboarding via the authed layout's no-family redirect.
 */
export default function SignUpPage() {
  const google = googleConfigured();
  const magicLink = credentialsConfigured();

  if (!google && !magicLink) {
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
            // Google provisions a first-time account; a fresh account has no family
            // yet, so onboarding resumes at the post-auth detail step.
            await signIn('google', { redirectTo: '/onboarding' });
          }}
        >
          <button type="submit" className="btn-primary w-full justify-center">
            Continue with Google
          </button>
        </form>
      ) : null}

      {google && magicLink ? (
        <div className="flex items-center gap-3">
          <span className="h-px flex-1 bg-spruce/15" />
          <span className="meta">or with email</span>
          <span className="h-px flex-1 bg-spruce/15" />
        </div>
      ) : null}

      {magicLink ? <MagicLinkRequestForm /> : null}

      <p className="meta">
        By continuing you agree to our{' '}
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
