import Link from 'next/link';
import { signIn } from '~/auth';
import { AuthShell } from '~/components/hale/auth-shell';
import { EmailSignInForm } from '~/components/hale/email-sign-in-form';
import { safeInternalRedirect } from '~/lib/auth/redirect';
import { credentialsConfigured, googleConfigured } from '~/lib/auth-config';

// Mirrors middleware.ts: the marketing/waitlist site newcomers are sent to.
const MARKETING_URL = process.env.NEXT_PUBLIC_MARKETING_URL ?? 'https://villagehale.com';

interface PageProps {
  searchParams: Promise<{ callbackUrl?: string }>;
}

export default async function SignInPage({ searchParams }: PageProps) {
  const { callbackUrl } = await searchParams;
  // Only honor app-internal redirect targets — never an off-site (incl.
  // protocol-relative) URL.
  const redirectTo = safeInternalRedirect(callbackUrl);
  const google = googleConfigured();
  const credentials = credentialsConfigured();

  if (!google && !credentials) {
    return (
      <AuthShell heading="Welcome back">
        <p className="meta">Sign-in isn&rsquo;t available in this preview yet.</p>
      </AuthShell>
    );
  }

  return (
    <AuthShell heading="Welcome back">
      {google ? (
        <form
          action={async () => {
            'use server';
            await signIn('google', { redirectTo });
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

      {credentials ? <EmailSignInForm redirectTo={redirectTo} secondary={google} /> : null}

      {credentials ? (
        <Link href="/sign-up" className="btn-ghost self-start">
          New to Hale? Create an account &rarr;
        </Link>
      ) : (
        <a href={MARKETING_URL} className="btn-ghost self-start">
          New to Hale? Learn more &rarr;
        </a>
      )}
    </AuthShell>
  );
}
