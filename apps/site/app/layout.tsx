import { SpeedInsights } from '@vercel/speed-insights/next';
import type { Metadata, Viewport } from 'next';
import { Instrument_Sans, JetBrains_Mono, Source_Serif_4 } from 'next/font/google';
import { PostHogProvider } from '~/lib/analytics/posthog-provider';
import { SITE_URL } from '~/lib/app-url';
import { f14LandingEnabled } from '~/lib/flags/landing';
import './globals.css';

const instrumentSans = Instrument_Sans({
  subsets: ['latin'],
  variable: '--font-sans',
  display: 'swap',
  weight: ['400', '500', '600', '700'],
});

const sourceSerif = Source_Serif_4({
  subsets: ['latin'],
  variable: '--font-serif',
  display: 'swap',
  style: ['normal', 'italic'],
  weight: ['500', '600'],
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
  display: 'swap',
  // Only the 400 weight renders (the footer pronunciation); the site's other
  // mono spots resolve to the serif accent, so 500/600 shipped unused.
  weight: ['400'],
});

// Metadata follows the landing flag (D21): the same deploy that turns on the
// chief-of-staff homepage turns on its positioning — link previews and search
// snippets must never describe a page visitors don't see.
const VILLAGE_META = {
  title: 'Hale · your parenting village, near you',
  description:
    'Hale brings back the village — the trusted local classes, groups, and drop-ins near you that GTA parents actually value — with a quiet AI that prepares the reminders and plans and never acts without your say-so. Your data stays in Canada.',
  ogDescription:
    'The trusted local village near you — the classes and groups other GTA parents actually value — with a quiet, approval-first AI helper, across every stage of childhood. Your data stays in Canada.',
  twitterDescription:
    'The trusted local village near you, plus a quiet AI that prepares and never acts without you. Your data stays in Canada.',
};
const CHIEF_OF_STAFF_META = {
  title: 'Hale · your family’s quiet chief of staff',
  description:
    'Hale is a number your family texts. It watches registration dates, plans the weekend, and handles the stuff that slips — always with your say-so. Your data stays in Canada.',
  ogDescription:
    'A number your family texts. Hale watches registration dates, plans the weekend, and handles the stuff that slips — always with your say-so. Your data stays in Canada.',
  twitterDescription:
    'A number your family texts. Registration dates watched, weekends planned, nothing sent without your say-so. Your data stays in Canada.',
};
const meta = f14LandingEnabled() ? CHIEF_OF_STAFF_META : VILLAGE_META;

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: meta.title,
  description: meta.description,
  alternates: { canonical: '/' },
  openGraph: {
    type: 'website',
    siteName: 'Hale',
    url: SITE_URL,
    title: meta.title,
    description: meta.ogDescription,
    locale: 'en_CA',
  },
  twitter: {
    card: 'summary_large_image',
    title: meta.title,
    description: meta.twitterDescription,
  },
};

export const viewport: Viewport = {
  // Matches the warm-white page background so the mobile browser chrome blends
  // with the top of every page (the site is light-only).
  themeColor: '#FDFCFA',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${instrumentSans.variable} ${sourceSerif.variable} ${jetbrainsMono.variable}`}
    >
      <body>
        <a href="#main" className="skip-link">
          Skip to content
        </a>
        <PostHogProvider>{children}</PostHogProvider>
        <SpeedInsights />
      </body>
    </html>
  );
}
