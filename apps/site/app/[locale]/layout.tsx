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
// must not depend on a third party serving a font. The two faces the site is set
// in are subset from the upstream google/fonts variable TTFs rather than taken
// from Fontsource, because both needed instancing this project's own way: latin +
// latin-ext, uprights, and Fraunces' SOFT/WONK axes pinned out.

// Figtree (SIL OFL), the body and UI face from 2026-08-20, at the seam Instrument
// Sans held. Variable 300–900 and registered across the whole range, so body 400
// and the 500–600 the buttons, the nav and the chat bubbles ask for all come off
// one master rather than off a synthesizer. Latin + latin-ext, so French keeps
// its diacritics and a European place name keeps its.
const figtree = localFont({
  src: [{ path: '../fonts/figtree-latin-wght-normal.woff2', weight: '300 900', style: 'normal' }],
  variable: '--font-sans',
  display: 'swap',
});

// The FALLBACK display face (--font-serif): variable 400–700, so a heading can be
// set at the weight its size needs. This is what a locale the Latin-only display
// face cannot set lands on — today, zh. No italic master is loaded here or
// anywhere: display type on this site is upright.
const sourceSerif = localFont({
  src: [
    { path: '../fonts/source-serif-4-latin-wght-normal.woff2', weight: '400 700', style: 'normal' },
  ],
  variable: '--font-serif',
  display: 'swap',
});

// Instrument Serif. Same self-hosted OFL discipline as the others (fetched from
// Fontsource, not a runtime Google request). One master exists (400), so exactly
// one thing binds it via --font-serif-display: the ≥1024px hero on the FALLBACK
// path, where it renders near 100px — today that means zh.
const instrumentSerif = localFont({
  src: [
    { path: '../fonts/instrument-serif-latin-400-normal.woff2', weight: '400', style: 'normal' },
  ],
  variable: '--font-serif-display',
  display: 'swap',
});

// Fraunces (SIL OFL, self-hosted like the rest — the licence text ships beside
// the binary in app/fonts/). The display face for every headline and legal title
// from 2026-08-20, replacing the single-master Bellefair. NOT the wordmark: the
// name is drawn art (components/wordmark.tsx), and not the hero deck either,
// which is body copy in the body face on purpose.
//
// TWO AXES SURVIVE THE SUBSET, and both are load-bearing. `wght` is the honest
// answer to a rung that measures lighter than the card heading beneath it — the
// thing a single master could only answer with size. `opsz` is applied for free
// under `font-optical-sizing: auto`: the browser feeds it the rendered size in
// px, so a 30px section heading gets the text cut and an 84px hero gets the
// display cut, which is a materially different drawing rather than the same
// outline scaled. That is also why it costs what it costs — the opsz deltas are
// ~60KB of the 129KB — and why nothing here pins it.
//
// SOFT and WONK are pinned OUT at build time (SOFT=0, WONK=0): the calm forms,
// no swapped-in wonky alternates, and two axes fewer to reason about. Uprights
// only; no italic master is loaded for any face on this site.
//
// Latin + latin-ext subset, so --font-fraunces is bound BY LOCALE ALLOWLIST in
// globals.css — zh keeps the Source Serif stack.
const fraunces = localFont({
  src: [{ path: '../fonts/fraunces-latin-opsz-wght-normal.woff2', weight: '100 900', style: 'normal' }],
  variable: '--font-fraunces',
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
      className={`${figtree.variable} ${sourceSerif.variable} ${instrumentSerif.variable} ${fraunces.variable} ${jetbrainsMono.variable}`}
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
        <PostHogProvider locale={locale}>{children}</PostHogProvider>
        <SpeedInsights />
      </body>
    </html>
  );
}
