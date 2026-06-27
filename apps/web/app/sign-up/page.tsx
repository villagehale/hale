import Link from 'next/link';
import { AuthShell } from '~/components/hale/auth-shell';
import { EmailSignUpForm } from '~/components/hale/email-sign-up-form';
import { credentialsConfigured } from '~/lib/auth-config';

// AUTH_SECRET is a runtime-only secret (not in the build env), so render at
// request time — otherwise credentialsConfigured() is evaluated at build with
// no secret and the page caches the "not configured" fallback.
export const dynamic = 'force-dynamic';

export default function SignUpPage() {
  const credentials = credentialsConfigured();

  return (
    <AuthShell heading="Join the village">
      {credentials ? (
        <>
          <EmailSignUpForm />
          <Link href="/sign-in" className="btn-ghost self-start">
            Already have an account? Sign in &rarr;
          </Link>
        </>
      ) : (
        <p className="meta">
          Sign-up isn&rsquo;t available in this preview — no auth provider is configured here.
        </p>
      )}
    </AuthShell>
  );
}
