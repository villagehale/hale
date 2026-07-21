import { SpeedInsights } from '@vercel/speed-insights/next';
import type { Metadata, Viewport } from 'next';
import { Instrument_Sans, JetBrains_Mono, Source_Serif_4 } from 'next/font/google';
import { PostHogProvider } from '~/lib/analytics/posthog-provider';
import { SITE_URL } from '~/lib/app-url';
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

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: 'Hale · your parenting village, near you',
  description:
    'Hale brings back the village — the trusted local classes, groups, and drop-ins near you that GTA parents actually value — with a quiet AI that prepares the reminders and plans and never acts without your say-so. Your data stays in Canada.',
  alternates: { canonical: '/' },
  openGraph: {
    type: 'website',
    siteName: 'Hale',
    url: SITE_URL,
    title: 'Hale · your parenting village, near you',
    description:
      'The trusted local village near you — the classes and groups other GTA parents actually value — with a quiet, approval-first AI helper, across every stage of childhood. Your data stays in Canada.',
    locale: 'en_CA',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Hale · your parenting village, near you',
    description:
      'The trusted local village near you, plus a quiet AI that prepares and never acts without you. Your data stays in Canada.',
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
