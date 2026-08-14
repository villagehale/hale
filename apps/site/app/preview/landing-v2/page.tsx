import type { Metadata } from 'next';
import { ChiefOfStaffLandingV2 } from '~/components/landing/chief-of-staff-v2';
import { readSmsNumber } from '~/lib/text-entry';

/**
 * The landing-v2 review surface. This route exists so the candidate homepage can
 * be looked at on a real Vercel preview URL without going anywhere near
 * villagehale.com/ — `app/page.tsx` is untouched and still serves v1 under
 * NEXT_PUBLIC_F14_LANDING.
 *
 * Noindex, nofollow and out of the sitemap: a second full copy of the homepage's
 * copy at a crawlable URL would be duplicate content against the page it is
 * auditioning to replace. It is also not linked from anywhere on the site —
 * reaching it means being handed the URL.
 *
 * If v2 wins, this directory is deleted in the same PR that swaps the component
 * into app/page.tsx. If it loses, the directory is deleted on its own.
 */

export const metadata: Metadata = {
  title: 'Hale · landing v2 (preview)',
  robots: { index: false, follow: false },
};

export default function LandingV2Preview() {
  // Read exactly the way the live page does, so the preview shows what the flip
  // would show: the sms: CTA when the Preview environment has a number, and the
  // honest email fallback when it does not.
  return <ChiefOfStaffLandingV2 smsNumber={readSmsNumber(process.env.NEXT_PUBLIC_HALE_SMS_NUMBER)} />;
}
