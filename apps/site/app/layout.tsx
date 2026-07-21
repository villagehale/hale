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
  weight: ['400', '500', '600'],
});

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: 'Hale · the best activities for your child, near you',
  description:
    'Hale finds the best activities for your child near you — real recommendations from GTA parents, and an AI that handles the booking and reminders. Your data stays in Canada.',
  alternates: { canonical: '/' },
  openGraph: {
    type: 'website',
    siteName: 'Hale',
    url: SITE_URL,
    title: 'Hale · the best activities for your child, near you',
    description:
      'Real recommendations from parents near you, and an AI that handles the booking — across every stage of childhood. Your data stays in Canada.',
    locale: 'en_CA',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Hale · the best activities for your child, near you',
    description:
      'Real recommendations from parents near you, and an AI that handles the booking. Your data stays in Canada.',
  },
};

export const viewport: Viewport = {
  themeColor: '#17294A',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${instrumentSans.variable} ${sourceSerif.variable} ${jetbrainsMono.variable}`}
    >
      <body>
        <PostHogProvider>{children}</PostHogProvider>
        <SpeedInsights />
      </body>
    </html>
  );
}
