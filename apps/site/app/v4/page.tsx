import type { Metadata } from 'next';
import { LandingV4 } from '~/components/landing/v4/landing-v4';
import { readSmsNumber } from '~/lib/text-entry';

/**
 * /v4 — a preview of the liquid-glass shore landing candidate. Not linked from
 * anywhere and kept out of search until it is chosen or dropped; the live
 * landing is still app/page.tsx.
 */
export const metadata: Metadata = {
  title: 'Hale · v4 preview',
  robots: { index: false, follow: false },
};

export default function V4PreviewPage() {
  return <LandingV4 smsNumber={readSmsNumber(process.env.NEXT_PUBLIC_HALE_SMS_NUMBER)} />;
}
