import Link from 'next/link';
import { signIn } from '~/auth';
import { AuthShell } from '~/components/hale/auth-shell';
import { MagicLinkRequestForm } from '~/components/hale/magic-link-request-form';
import { safeInternalRedirect } from '~/lib/auth/redirect';
import { credentialsConfigured, googleConfigured } from '~/lib/auth-config';

// AUTH_SECRET is a runtime-only secret, so evaluate configuredness at request time
// rather than caching a build-time "not configured" fallback.
export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: Promise<{ callbackUrl?: string }>;
}

/**
 * Web sign-in — Google + a passwordless magic link only (locked auth decision: no
 * password UI, no Apple on web). The magic link doubles as sign-up (it mints for
 * any valid address), so the same email field serves returning and new parents.
 * The server-side password provider is untouched; /forgot-password + /reset-password
 * stay reachable by direct link (old emails) but are no longer surfaced here.
 */
export default async function SignInPage({ searchParams }: PageProps) {
  const { callbackUrl } = await searchParams;
  // Only honor app-internal redirect targets — never an off-site (incl.
  // protocol-relative) URL.
  const redirectTo = safeInternalRedirect(callbackUrl);
  const google = googleConfigured();
  const magicLink = credentialsConfigured();

  if (!google && !magicLink) {
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

      <Link href="/sign-up" className="btn-ghost self-start">
        New to Hale? Create an account &rarr;
      </Link>
    </AuthShell>
  );
}
