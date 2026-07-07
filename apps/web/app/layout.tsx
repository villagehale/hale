import type { Metadata, Viewport } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import { PostHogProvider } from '~/lib/analytics/posthog-provider';
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
  title: 'Village Hale · the village your family lost',
  description:
    "Village Hale is the village your family lost, rebuilt through AI — across every stage of childhood. It finds the genuinely good local things to do, matched to your child, and makes them happen: registering, calendar, reminders, gear. Your family's data stays in Canada.",
};

export const viewport: Viewport = {
  themeColor: '#01204F',
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
      className={`${inter.variable} ${jetbrainsMono.variable}`}
      suppressHydrationWarning
    >
      <head>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: pre-paint theme script must run before hydration to avoid a flash of the wrong theme */}
        <script dangerouslySetInnerHTML={{ __html: NO_FLASH_SCRIPT }} />
      </head>
      <body>
        <PostHogProvider>{children}</PostHogProvider>
      </body>
    </html>
  );
}
