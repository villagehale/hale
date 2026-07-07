import { SpeedInsights } from '@vercel/speed-insights/next';
import type { Metadata, Viewport } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import { PostHogProvider } from '~/lib/analytics/posthog-provider';
import { SITE_URL } from '~/lib/app-url';
import { THEME_STORAGE_KEY } from '~/lib/theme';
import './globals.css';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-sans',
  display: 'swap',
  weight: ['400', '500', '600', '700'],
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
  display: 'swap',
  weight: ['400', '500', '600'],
});

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: 'Village Hale · the village every parent needs',
  description:
    'Village Hale is the trusted parent network for your neighborhood — find what families near you actually do, and share what you love. Your data stays in Canada.',
  alternates: { canonical: '/' },
  openGraph: {
    type: 'website',
    siteName: 'Village Hale',
    url: SITE_URL,
    title: 'Village Hale · the village every parent needs',
    description:
      'Find what families near you actually do, and share what you love — across every stage of childhood. Your data stays in Canada.',
    locale: 'en_CA',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Village Hale · the village every parent needs',
    description:
      'Find what families near you actually do, and share what you love. Your data stays in Canada.',
  },
};

export const viewport: Viewport = {
  themeColor: '#01204F',
};

// Runs before first paint to set the .dark class from the stored preference (or
// the OS setting when on "system"), so the page never flashes the wrong theme.
// Mirrors lib/theme.ts; kept inline because it must execute before hydration.
const NO_FLASH_SCRIPT = `(function(){try{var k=${JSON.stringify(THEME_STORAGE_KEY)};var p=localStorage.getItem(k);if(p!=='light'&&p!=='dark'&&p!=='system')p='system';var dark=p==='dark'||(p==='system'&&window.matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.classList.toggle('dark',dark);}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${jetbrainsMono.variable}`}
      suppressHydrationWarning
    >
      <head>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: pre-paint theme script must run before hydration to avoid a flash of the wrong theme */}
        <script dangerouslySetInnerHTML={{ __html: NO_FLASH_SCRIPT }} />
      </head>
      <body>
        <PostHogProvider>{children}</PostHogProvider>
        <SpeedInsights />
      </body>
    </html>
  );
}
