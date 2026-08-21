import type { Metadata, Viewport } from 'next';
import localFont from 'next/font/local';
import { AppPromo } from '~/components/hale/app-promo';
import { PostHogProvider } from '~/lib/analytics/posthog-provider';
import { THEME_STORAGE_KEY } from '~/lib/theme';
import './globals.css';

// Body / UI face — Figtree, replacing Instrument Sans at this registration seam so
// the authed app and the marketing site are one identity (a CTA on the site lands on
// /sign-in, and the two used to change face across that step). Exposed as
// --font-sans, which globals.css maps to --font-body and --font-mono.
//
// Self-hosted variable master (app/fonts/, Fontsource-packaged, OFL beside the
// binary): next/font/google fetched at BUILD time and a Google CDN outage failed
// three deploys on 2026-08-12, so builds no longer depend on it. Latin + latin-ext,
// which is what the app's copy and its French diacritics need.
const figtree = localFont({
  src: [{ path: './fonts/figtree-latin-wght-normal.woff2', weight: '300 900', style: 'normal' }],
  variable: '--font-sans',
  display: 'swap',
});

// Display / headings face — Fraunces (globals.css maps it to --font-display).
//
// Variable in TWO axes, and both are load-bearing. `wght` is registered across its
// full 100–900 because understating it makes next/font declare a narrower @font-face
// than the file supports and hands the rest back to the synthesizer — the smeared
// bold `font-synthesis-weight: none` exists to forbid. `opsz` (9–144) is never set
// here: `font-optical-sizing: auto` in globals.css lets the browser track it to the
// rendered size, which is what keeps the 22px stage heading and the 76px hero from
// rendering the same drawing. No italic master is loaded; display type is upright.
const fraunces = localFont({
  src: [
    { path: './fonts/fraunces-latin-opsz-wght-normal.woff2', weight: '100 900', style: 'normal' },
  ],
  variable: '--font-serif',
  display: 'swap',
});

// Hale Shore is a two-family system: numbers, dates and payloads render in the body
// face, so no mono face is loaded. globals.css points --font-mono at --font-sans, and
// `.tabular` keeps `font-variant-numeric` for the column alignment that role actually
// needed (apps/mobile/DESIGN.md § Type).

export const metadata: Metadata = {
  title: 'Hale · the village your family lost',
  description:
    "Hale is the village your family lost, rebuilt through AI — across every stage of childhood. It finds the genuinely good local things to do, matched to your child, and makes them happen: registering, calendar, reminders, gear. Your family's data stays in Canada.",
};

export const viewport: Viewport = {
  // Match the mobile browser chrome to the real page canvas in each scheme — Shore
  // warm white in light, deep Prussian navy in dark — instead of a single navy that
  // clashes over the light page. These MUST track globals.css --color-canvas in
  // :root / .dark; a literal is unavoidable here (Next needs a static value), and
  // globals-tokens.test.ts is the gate that keeps the two in step.
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#FDFCFA' },
    { media: '(prefers-color-scheme: dark)', color: '#0E1A2F' },
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
    <html lang="en" className={`${figtree.variable} ${fraunces.variable}`} suppressHydrationWarning>
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
