import type { Metadata } from 'next';
import { ClaimByPhoneForm } from '~/components/hale/claim-by-phone-form';
import { ConnectStage } from '~/components/hale/connect/connect-stage';
import { safeInternalRedirect } from '~/lib/auth/redirect';
import { haleTextsNumber } from '~/lib/channel/connect/hale-texts-href';
import { parsePortalSourceCode } from '~/lib/text-hale-target';

export const metadata: Metadata = { title: 'Sign in' };

// AUTH_SECRET is a runtime-only secret, so evaluate configuredness at request time
// rather than caching a build-time "not configured" fallback.
export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: Promise<{ callbackUrl?: string; s?: string | string[] }>;
}

/**
 * Web sign-in is the phone door. Hale is a number you text, so the only account
 * the portal can serve is one it has a number for, and the only door shown is
 * the one that proves you hold it.
 *
 * This does not read F14_RECEIPTS_IA. That flag still chooses the receipts shell
 * (home, family, settings). It used to swap this page to a Google button plus a
 * magic-link form. Those email doors are gone, and a flag-off branch that still
 * rendered the form would post to a route that no longer exists. Phone is the
 * safe door in both states. There is no Google sign-in provider. Connecting
 * Gmail or Calendar is a separate consent on /connect.
 */
export default async function SignInPage({ searchParams }: PageProps) {
  const { callbackUrl, s } = await searchParams;
  // Only honor app-internal redirect targets — never an off-site (incl.
  // protocol-relative) URL.
  const redirectTo = safeInternalRedirect(callbackUrl);

  return (
    <ConnectStage>
      <ClaimByPhoneForm
        callbackUrl={redirectTo}
        smsNumber={haleTextsNumber()}
        source={parsePortalSourceCode(s)}
      />
    </ConnectStage>
  );
}
