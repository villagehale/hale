import { SpeedInsights } from '@vercel/speed-insights/next';
import type { Metadata, Viewport } from 'next';
import localFont from 'next/font/local';
import { PostHogProvider } from '~/lib/analytics/posthog-provider';
import { SITE_URL } from '~/lib/app-url';
import './globals.css';

// Self-hosted variable fonts (app/fonts/, Fontsource-packaged, OFL). next/font/google
// fetched these from fonts.gstatic.com AT BUILD TIME, and a Google CDN outage failed
// three deploys on 2026-08-12 — including branches that touched no site file. A build
// must not depend on a third party serving a font.
const instrumentSans = localFont({
  src: [{ path: './fonts/instrument-sans-latin-wght-normal.woff2', weight: '400 700', style: 'normal' }],
  variable: '--font-sans',
  display: 'swap',
});

const sourceSerif = localFont({
  src: [
    { path: './fonts/source-serif-4-latin-wght-normal.woff2', weight: '400 700', style: 'normal' },
    { path: './fonts/source-serif-4-latin-wght-italic.woff2', weight: '400 700', style: 'italic' },
  ],
  variable: '--font-serif',
  display: 'swap',
});

const jetbrainsMono = localFont({
  // Only the 400 weight renders (the footer pronunciation); the site's other
  // mono spots resolve to the serif accent.
  src: [{ path: './fonts/jetbrains-mono-latin-wght-normal.woff2', weight: '400', style: 'normal' }],
  variable: '--font-mono',
  display: 'swap',
});

// The homepage's positioning in one object (D21): link previews and search snippets
// must describe the page a visitor actually lands on.
const meta = {
  title: 'Hale · your family’s quiet chief of staff',
  description:
    'Hale is a number your family texts. It watches registration dates, plans the weekend, and handles the stuff that slips — always with your say-so. Your data stays in Canada.',
  ogDescription:
    'A number your family texts. Hale watches registration dates, plans the weekend, and handles the stuff that slips — always with your say-so. Your data stays in Canada.',
  twitterDescription:
    'A number your family texts. Registration dates watched, weekends planned, nothing sent without your say-so. Your data stays in Canada.',
};

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
