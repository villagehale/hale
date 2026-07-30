import type { Metadata } from 'next';
import { TextEntry } from '~/components/text-entry';
import { parseSourceCode, readSmsNumber } from '~/lib/text-entry';

/**
 * villagehale.com/text — the QR cards' landing surface (VIL-240 · M5).
 *
 * Dark on purpose: no nav or footer links here, no sitemap entry, and noindex
 * until the number is provisioned and the cards are actually in the world. The
 * only way in is a printed card or a link a founder hands over.
 */

const TITLE = 'Text Hale';
const DESCRIPTION = 'Start a conversation with Hale, your family’s quiet chief of staff.';

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  // Overrides the layout's site-wide canonical, which would otherwise point this
  // page at the homepage.
  alternates: { canonical: '/text' },
  robots: { index: false, follow: false },
};

export default async function TextEntryPage({
  searchParams,
}: {
  searchParams: Promise<{ s?: string | string[] }>;
}) {
  const { s } = await searchParams;

  return (
    <TextEntry
      source={parseSourceCode(s)}
      smsNumber={readSmsNumber(process.env.NEXT_PUBLIC_HALE_SMS_NUMBER)}
    />
  );
}
