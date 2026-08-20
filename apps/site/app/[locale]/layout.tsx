import { SpeedInsights } from '@vercel/speed-insights/next';
import type { Metadata, Viewport } from 'next';
import { hasLocale } from 'next-intl';
import localFont from 'next/font/local';
import { notFound } from 'next/navigation';
import { buildAlternates, ogLocale } from '~/i18n/metadata';
import { localeHref } from '~/i18n/navigation';
import { type Locale, routing } from '~/i18n/routing';
import { getTranslator } from '~/i18n/server';
import { PostHogProvider } from '~/lib/analytics/posthog-provider';
import { SITE_URL } from '~/lib/app-url';
import { NO_FLASH_SCRIPT, THEME_COLOR } from '~/lib/site/theme';
import '../globals.css';

// Self-hosted variable fonts (app/fonts/, Fontsource-packaged, OFL). next/font/google
// fetched these from fonts.gstatic.com AT BUILD TIME, and a Google CDN outage failed
// three deploys on 2026-08-12 — including branches that touched no site file. A build
// must not depend on a third party serving a font.
const instrumentSans = localFont({
  src: [{ path: '../fonts/instrument-sans-latin-wght-normal.woff2', weight: '400 700', style: 'normal' }],
  variable: '--font-sans',
  display: 'swap',
});

// The display face for the whole site (--font-serif): variable 400–700, so a
// heading can be set at the weight its size needs. No italic master is loaded —
// display type here is upright, and the one accent per headline is colour.
const sourceSerif = localFont({
  src: [
    { path: '../fonts/source-serif-4-latin-wght-normal.woff2', weight: '400 700', style: 'normal' },
  ],
  variable: '--font-serif',
  display: 'swap',
});

// Instrument Serif, the serif sibling of our body Instrument Sans. Same self-hosted
// OFL discipline as the others (fetched from Fontsource, not a runtime Google
// request). One master exists (400), so exactly one thing binds it via
// --font-serif-display: the landing hero at ≥1024px, where it renders near 100px.
const instrumentSerif = localFont({
  src: [
    { path: '../fonts/instrument-serif-latin-400-normal.woff2', weight: '400', style: 'normal' },
  ],
  variable: '--font-serif-display',
  display: 'swap',
});

// Bellefair (SIL OFL, self-hosted like the four above — the licence text ships
// beside the binary in app/fonts/). The display face for every headline, deck and
// legal title from 2026-08-20. NOT the wordmark: the name is drawn art now
// (components/wordmark.tsx), which is what took the last Bellefair rule out of
// the locale allowlist's exception list.
//
// ONE MASTER, and that is the whole design constraint. There is no 500 and no
// 700 to reach for, so nothing may ask for one: a `font-weight: 700` here would
// be synthesized into exactly the smeared bold #506 removed, which is why every
// surface that names this face also sets `font-synthesis-weight: none` and why
// the compensation for a rung that measures too light is SIZE, never weight.
//
// Latin-only subset (latin + latin-ext, so French keeps its diacritics), so
// --font-bellefair is bound BY LOCALE ALLOWLIST in globals.css — zh keeps the
// Source Serif stack. No italic master exists.
const bellefair = localFont({
  src: [{ path: '../fonts/bellefair-latin-400-normal.woff2', weight: '400', style: 'normal' }],
  variable: '--font-bellefair',
  display: 'swap',
});

const jetbrainsMono = localFont({
  // Only the 400 weight renders (the footer pronunciation); the site's other
  // mono spots resolve to the serif accent.
  src: [{ path: '../fonts/jetbrains-mono-latin-wght-normal.woff2', weight: '400', style: 'normal' }],
  variable: '--font-mono',
  display: 'swap',
});

export function generateStaticParams(): { locale: Locale }[] {
  return routing.locales.map((locale) => ({ locale }));
}

// The homepage's positioning (D21): link previews and search snippets must
// describe the page a visitor actually lands on, in the language they land in.
export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: Locale }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = getTranslator(locale, 'HomeMeta');
  return {
    metadataBase: new URL(SITE_URL),
    title: t('title'),
    description: t('description'),
    alternates: buildAlternates(locale, '/'),
    openGraph: {
      type: 'website',
      siteName: 'Hale',
      url: localeHref(locale, '/'),
      title: t('title'),
      description: t('ogDescription'),
      locale: ogLocale(locale),
    },
    twitter: {
      card: 'summary_large_image',
      title: t('title'),
      description: t('twitterDescription'),
    },
  };
}

export const viewport: Viewport = {
  // Matches the real page canvas in each scheme — warm white in light, deep
  // Prussian navy in dark — so the mobile browser chrome blends with the top of
  // every page. These MUST track globals.css --color-linen; a literal is
  // unavoidable here (Next needs a static value), and lib/site/theme.ts carries
  // the same pair for the toggle's override tag.
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: THEME_COLOR.light },
    { media: '(prefers-color-scheme: dark)', color: THEME_COLOR.dark },
  ],
};

export default async function RootLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  const t = getTranslator(locale, 'Common');

  return (
    <html
      lang={locale}
      className={`${instrumentSans.variable} ${sourceSerif.variable} ${instrumentSerif.variable} ${bellefair.variable} ${jetbrainsMono.variable}`}
      suppressHydrationWarning
    >
      <head>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: the pre-paint theme
            script must run before hydration, or the page flashes the wrong theme. */}
        <script dangerouslySetInnerHTML={{ __html: NO_FLASH_SCRIPT }} />
      </head>
      <body>
        <a href="#main" className="skip-link">
          {t('skipToContent')}
        </a>
        <PostHogProvider>{children}</PostHogProvider>
        <SpeedInsights />
      </body>
    </html>
  );
}
