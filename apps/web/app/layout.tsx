import type { Metadata } from 'next';
import { Fraunces, Spline_Sans_Mono, Caveat } from 'next/font/google';
import { GrainOverlay } from '~/components/mira/grain-overlay';
import './globals.css';

const fraunces = Fraunces({
  subsets: ['latin'],
  variable: '--font-display',
  display: 'swap',
  axes: ['SOFT', 'WONK', 'opsz'],
});

const splineSansMono = Spline_Sans_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
  display: 'swap',
  weight: ['400', '500', '600'],
});

const caveat = Caveat({
  subsets: ['latin'],
  variable: '--font-hand',
  display: 'swap',
  weight: ['400', '500'],
});

export const metadata: Metadata = {
  title: 'mira',
  description: 'a quiet ai for new parents.',
  themeColor: '#f5efe3',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${fraunces.variable} ${splineSansMono.variable} ${caveat.variable}`}
    >
      <body>
        <GrainOverlay />
        {children}
      </body>
    </html>
  );
}
