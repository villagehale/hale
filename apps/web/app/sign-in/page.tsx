import { signIn } from '~/auth';
import { AuthShell } from '~/components/hale/auth-shell';
import { ClaimByPhoneForm } from '~/components/hale/claim-by-phone-form';
import { GoogleGlyph } from '~/components/hale/google-glyph';
import { MagicLinkRequestForm } from '~/components/hale/magic-link-request-form';
import { credentialsConfigured, googleConfigured } from '~/lib/auth-config';
import { safeInternalRedirect } from '~/lib/auth/redirect';
import { receiptsIaEnabled } from '~/lib/flags/receipts-ia';
import { MARKETING_SITE_URL } from '~/lib/legal-links';

// AUTH_SECRET is a runtime-only secret, so evaluate configuredness at request time
// rather than caching a build-time "not configured" fallback.
export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: Promise<{ callbackUrl?: string }>;
}

/**
 * Web sign-in.
 *
 * FLAG OFF — the locked pre-F14 page: Google + a passwordless magic link (no password
 * UI, no Apple on web). The magic link doubles as sign-up, so one email field serves
 * returning and new parents.
 *
 * FLAG ON — the phone REPLACES both. Not an addition: Hale is a number you text, so
 * the only account it can actually serve is one it has a number for, and the only door
 * shown is the one that proves you hold it. There is no create-account affordance
 * either, because there is no longer a web way to be born a family — /onboarding is
 * gone and the wizard with it.
 *
 * The credentials + Google providers themselves are UNTOUCHED on the server: this
 * hides their UI, it does not remove the ability to sign in through them (prod QA
 * mints sessions, and the remaining test accounts still resolve). One flag, one
 * reader, reversible by unsetting it.
 */
export default async function SignInPage({ searchParams }: PageProps) {
  const { callbackUrl } = await searchParams;
  // Only honor app-internal redirect targets — never an off-site (incl.
  // protocol-relative) URL.
  const redirectTo = safeInternalRedirect(callbackUrl);
  const google = googleConfigured();
  const magicLink = credentialsConfigured();
  // The same reader the request endpoint and the provider use, so the door and the
  // button can never disagree about being open.
  const phoneOnly = receiptsIaEnabled();

  if (phoneOnly) {
    return (
      <AuthShell heading="Welcome back" subtitle="Sign in with the number you text me on.">
        <ClaimByPhoneForm callbackUrl={redirectTo} />
      </AuthShell>
    );
  }

  if (!google && !magicLink) {
    return (
      <AuthShell heading="Welcome back">
        <p className="meta">Sign-in isn&rsquo;t available in this preview yet.</p>
      </AuthShell>
    );
  }

  // (M9's link-first ordering lived here. It was conditioned on the same flag, and
  // under that flag there is no emailed link to order any more — the branch above
  // returns first — so the ordering went with it rather than lingering as a condition
  // that can no longer be true.)
  const googleButton = google ? (
    <form
      action={async () => {
        'use server';
        await signIn('google', { redirectTo });
      }}
    >
      <button type="submit" className="auth-google">
        <GoogleGlyph />
        Continue with Google
      </button>
    </form>
  ) : null;

  const magicLinkForm = magicLink ? (
    <MagicLinkRequestForm variant="inline" callbackUrl={redirectTo} />
  ) : null;

  return (
    <AuthShell heading="Welcome back" subtitle="Sign in to your village.">
      {googleButton}

      {google && magicLink ? <div className="auth-or">or</div> : null}

      {magicLinkForm}

      {/* The join funnel left the app with /onboarding (F14): joining starts on the
          marketing site, which explains that Hale is a number you text. A plain
          anchor, like every other off-app link here — it leaves the router's world. */}
      <a href={MARKETING_SITE_URL} className="btn-ghost self-start">
        New here? Join the village &rarr;
      </a>
    </AuthShell>
  );
}
