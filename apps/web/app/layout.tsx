import type { Metadata, Viewport } from 'next';
import { Newsreader, JetBrains_Mono } from 'next/font/google';
import { GrainOverlay } from '~/components/mira/grain-overlay';
import './globals.css';

const newsreader = Newsreader({
  subsets: ['latin'],
  variable: '--font-display',
  display: 'swap',
  axes: ['opsz'],
  style: ['normal', 'italic'],
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
  display: 'swap',
  weight: ['400', '500', '600'],
});

export const metadata: Metadata = {
  title: 'mira — quiet ai for new parents',
  description: 'mira watches your inbox, calendar, and household admin so you can hold your baby.',
};

export const viewport: Viewport = {
  themeColor: '#f4ecdd',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${newsreader.variable} ${jetbrainsMono.variable}`}>
      <body>
        <GrainOverlay />
        {children}
      </body>
    </html>
  );
}
