import type { Metadata } from 'next';
import { ClaimByPhoneForm } from '~/components/hale/claim-by-phone-form';
import { ConnectStage } from '~/components/hale/connect/connect-stage';
import { safeInternalRedirect } from '~/lib/auth/redirect';
import { haleTextsNumber } from '~/lib/channel/connect/hale-texts-href';
import { noStopKeywordCopyEnabled } from '~/lib/channel/no-stop-keyword';
import { MARKETING_OG_IMAGE } from '~/lib/legal-links';
import { parsePortalSourceCode } from '~/lib/text-hale-target';

// Same sentence as the root layout. Repeated here so this page's share card
// keeps it when its own Open Graph fields replace the layout's.
const PORTAL_DESCRIPTION =
  'Sign in to Hale to see your family, your messages with Hale, and your settings.';

export const metadata: Metadata = {
  title: 'Sign in',
  description: PORTAL_DESCRIPTION,
  openGraph: {
    title: 'Sign in · Hale',
    description: PORTAL_DESCRIPTION,
    images: [MARKETING_OG_IMAGE],
    siteName: 'Hale',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Sign in · Hale',
    description: PORTAL_DESCRIPTION,
    images: [MARKETING_OG_IMAGE],
  },
};

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
 * This does not read F14_RECEIPTS_IA. The email doors are gone. There is no
 * Google sign-in provider. Connecting Gmail or Calendar is a separate consent
 * on /connect.
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
        noStopKeyword={noStopKeywordCopyEnabled()}
      />
    </ConnectStage>
  );
}
