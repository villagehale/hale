import type { Metadata, Viewport } from 'next';
import { Instrument_Sans, JetBrains_Mono, Source_Serif_4 } from 'next/font/google';
import { AppPromo } from '~/components/hale/app-promo';
import { PostHogProvider } from '~/lib/analytics/posthog-provider';
import { THEME_STORAGE_KEY } from '~/lib/theme';
import './globals.css';

// Body / UI face — Instrument Sans (design handoff §2.2). Exposed as --font-sans,
// which globals.css maps to --font-body.
const instrumentSans = Instrument_Sans({
  subsets: ['latin'],
  variable: '--font-sans',
  display: 'swap',
  weight: ['400', '500', '600', '700'],
});

// Display / headings face — Source Serif 4, used for hero H1s, page titles, and the
// "Hale" wordmark only (globals.css maps it to --font-display).
const sourceSerif = Source_Serif_4({
  subsets: ['latin'],
  variable: '--font-serif',
  display: 'swap',
  weight: ['500', '600'],
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
  display: 'swap',
  weight: ['400', '500', '600'],
});

export const metadata: Metadata = {
  title: 'Hale · the village your family lost',
  description:
    "Hale is the village your family lost, rebuilt through AI — across every stage of childhood. It finds the genuinely good local things to do, matched to your child, and makes them happen: registering, calendar, reminders, gear. Your family's data stays in Canada.",
};

export const viewport: Viewport = {
  // Match the mobile browser chrome to the real page canvas in each scheme — cream
  // in light (--color-linen), deep charcoal-navy in dark — instead of a single navy
  // that clashes over the light cream page (globals.css :root / .dark canvases).
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#F2F0EA' },
    { media: '(prefers-color-scheme: dark)', color: '#12161F' },
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
      className={`${instrumentSans.variable} ${sourceSerif.variable} ${jetbrainsMono.variable}`}
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
