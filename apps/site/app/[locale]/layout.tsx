import { SpeedInsights } from '@vercel/speed-insights/next';
import type { Metadata, Viewport } from 'next';
import { hasLocale } from 'next-intl';
import localFont from 'next/font/local';
import { notFound } from 'next/navigation';
import { buildAlternates, ogLocale } from '~/i18n/metadata';
import { localeHref } from '~/i18n/navigation';
import { type Locale, routing } from '~/i18n/routing';
import { getTranslator } from '~/i18n/server';
import { GoogleAdsTag } from '~/lib/analytics/google-ads-tag';
import { PostHogProvider } from '~/lib/analytics/posthog-provider';
import { SITE_URL } from '~/lib/app-url';
import { MUNICIPALITY_COUNT } from '~/lib/site/municipalities';
import { NO_FLASH_SCRIPT, THEME_COLOR } from '~/lib/site/theme';
import '../globals.css';

// Self-hosted variable fonts (app/fonts/, Fontsource-packaged, OFL). next/font/google
// fetched these from fonts.gstatic.com AT BUILD TIME, and a Google CDN outage failed
// three deploys on 2026-08-12 — including branches that touched no site file. A build
// must not depend on a third party serving a font. The faces the site still
// self-hosts are subset from the upstream google/fonts variable TTFs rather than
// taken from Fontsource: latin + latin-ext, uprights only.

// Figtree (SIL OFL) is the UI face — nav, buttons, fields, bubbles. It is not
// the body and not the headings. Variable 300–900 and registered across the
// whole range, so the 500–600 the buttons, the nav and the chat bubbles ask for
// all come off one master rather than off a synthesizer. Latin + latin-ext, so
// French keeps its diacritics and a European place name keeps its.
const figtree = localFont({
  src: [{ path: '../fonts/figtree-latin-wght-normal.woff2', weight: '300 900', style: 'normal' }],
  variable: '--font-sans',
  display: 'swap',
});

// Body face (--font-serif, which --font-body follows). Variable 400–700, already
// licensed and self-hosted. No italic master is loaded here or anywhere.
const sourceSerif = localFont({
  src: [
    { path: '../fonts/source-serif-4-latin-wght-normal.woff2', weight: '400 700', style: 'normal' },
  ],
  variable: '--font-serif',
  display: 'swap',
});

// Instrument Serif. Same self-hosted OFL discipline as the others. One master
// exists (400), so exactly one thing binds it via --font-serif-display: the
// landing card numerals. Headings do not.
const instrumentSerif = localFont({
  src: [
    { path: '../fonts/instrument-serif-latin-400-normal.woff2', weight: '400', style: 'normal' },
  ],
  variable: '--font-serif-display',
  display: 'swap',
});

// Fraunces stays on disk (app/fonts/, OFL) and is not registered. Headings use
// the system stack on --font-display, so preloading the variable master would
// ship a face the page does not paint.

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
  // The town count is a derived number, never a hand-written one: a 22nd
  // municipality must not leave the search snippet claiming 21 (municipalities.ts
  // derives it from the list for the same reason the page does).
  const counted = { count: MUNICIPALITY_COUNT };
  return {
    metadataBase: new URL(SITE_URL),
    title: t('title'),
    description: t('description', counted),
    alternates: buildAlternates(locale, '/'),
    openGraph: {
      type: 'website',
      siteName: 'Hale',
      url: localeHref(locale, '/'),
      title: t('title'),
      description: t('ogDescription', counted),
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
      className={`${figtree.variable} ${sourceSerif.variable} ${instrumentSerif.variable} ${jetbrainsMono.variable}`}
      suppressHydrationWarning
    >
      <head>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: the pre-paint theme
            script must run before hydration, or the page flashes the wrong theme. */}
        <script dangerouslySetInnerHTML={{ __html: NO_FLASH_SCRIPT }} />
        <GoogleAdsTag />
      </head>
      <body>
        <a href="#main" className="skip-link">
          {t('skipToContent')}
        </a>
        <PostHogProvider locale={locale}>{children}</PostHogProvider>
        <SpeedInsights />
      </body>
    </html>
  );
}
