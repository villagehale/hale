import type { Metadata } from 'next';
import { PalletLandingV2b } from '~/components/landing/pallet-v2b/landing-v2b';
import { readSmsNumber } from '~/lib/text-entry';

/**
 * Landing v2b preview — the "Pallet" variant, for founder comparison against v2.
 * Not linked from anywhere and noindex/nofollow: it is a second draft of the
 * homepage, and two pages making the same claims must never both be crawlable.
 *
 * Head parity with the live homepage is deliberate (same title/description/OG
 * copy as the chief-of-staff metadata in app/layout.tsx) so the comparison is of
 * the page, not of its link preview. The JSON-LD comes from the same
 * `siteJsonLd()` the homepage uses.
 */

const TITLE = 'Hale · your family’s quiet chief of staff';
const DESCRIPTION =
  'Hale is a number your family texts. It watches registration dates, plans the weekend, and handles the stuff that slips — always with your say-so. Your data stays in Canada.';

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  robots: { index: false, follow: false },
  openGraph: {
    type: 'website',
    siteName: 'Hale',
    title: TITLE,
    description:
      'A number your family texts. Hale watches registration dates, plans the weekend, and handles the stuff that slips — always with your say-so. Your data stays in Canada.',
    locale: 'en_CA',
  },
  twitter: {
    card: 'summary_large_image',
    title: TITLE,
    description:
      'A number your family texts. Registration dates watched, weekends planned, nothing sent without your say-so. Your data stays in Canada.',
  },
};

export default function LandingV2bPreview() {
  return <PalletLandingV2b smsNumber={readSmsNumber(process.env.NEXT_PUBLIC_HALE_SMS_NUMBER)} />;
}
