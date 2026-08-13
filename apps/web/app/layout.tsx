import type { Metadata, Viewport } from 'next';
import localFont from 'next/font/local';
import { AppPromo } from '~/components/hale/app-promo';
import { PostHogProvider } from '~/lib/analytics/posthog-provider';
import { THEME_STORAGE_KEY } from '~/lib/theme';
import './globals.css';

// Body / UI face — Instrument Sans (design handoff §2.2). Exposed as --font-sans,
// which globals.css maps to --font-body. Self-hosted variable font (app/fonts/,
// Fontsource-packaged, OFL): next/font/google fetched at BUILD time and a Google CDN
// outage failed three deploys on 2026-08-12, so builds no longer depend on it.
const instrumentSans = localFont({
  src: [{ path: './fonts/instrument-sans-latin-wght-normal.woff2', weight: '400 700', style: 'normal' }],
  variable: '--font-sans',
  display: 'swap',
});

// Display / headings face — Source Serif 4, used for hero H1s, page titles, and the
// "Hale" wordmark only (globals.css maps it to --font-display).
const sourceSerif = localFont({
  src: [{ path: './fonts/source-serif-4-latin-wght-normal.woff2', weight: '400 700', style: 'normal' }],
  variable: '--font-serif',
  display: 'swap',
});

// Hale Shore is a two-family system: numbers, dates and payloads render in
// Instrument Sans, so the old JetBrains Mono face is not loaded. globals.css points
// --font-mono at --font-sans, and `.tabular` keeps `font-variant-numeric` for the
// column alignment that role actually needed (apps/mobile/DESIGN.md § Type).

export const metadata: Metadata = {
  title: 'Hale · the village your family lost',
  description:
    "Hale is the village your family lost, rebuilt through AI — across every stage of childhood. It finds the genuinely good local things to do, matched to your child, and makes them happen: registering, calendar, reminders, gear. Your family's data stays in Canada.",
};

export const viewport: Viewport = {
  // Match the mobile browser chrome to the real page canvas in each scheme — Shore
  // warm white in light, deep charcoal-navy in dark — instead of a single navy that
  // clashes over the light page. These MUST track globals.css --color-canvas in
  // :root / .dark; a literal is unavoidable here (Next needs a static value).
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#FDFCFA' },
    { media: '(prefers-color-scheme: dark)', color: '#14120E' },
  ],
};

// Runs before first paint: sets the .dark class from the stored preference (so the
// page never flashes the wrong theme), and switches scroll restoration to manual.
// The app scrolls inside .main-stage, not the window; with the default "auto" the
// browser re-applies the stage's old offset on reload AFTER React mounts, undoing
// the scroll reset — so we disable it here, before any restoration can happen.
// Kept inline because it must execute before hydration.
const NO_FLASH_SCRIPT = `(function(){try{var k=${JSON.stringify(THEME_STORAGE_KEY)};var p=localStorage.getItem(k);if(p!=='light'&&p!=='dark'&&p!=='system')p='system';var dark=p==='dark'||(p==='system'&&window.matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.classList.toggle('dark',dark);if('scrollRestoration' in history){history.scrollRestoration='manual';}}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${instrumentSans.variable} ${sourceSerif.variable}`}
      suppressHydrationWarning
    >
      <head>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: pre-paint theme script must run before hydration to avoid a flash of the wrong theme */}
        <script dangerouslySetInnerHTML={{ __html: NO_FLASH_SCRIPT }} />
      </head>
      <body>
        <PostHogProvider>{children}</PostHogProvider>
        {/* <768px "better in the app" hand-off (§5) — flag-gated, session-scoped;
         * mounted at the root so it covers the authed shell AND the public auth
         * pages, and renders nothing at ≥768px (no layout shift). */}
        <AppPromo />
      </body>
    </html>
  );
}
