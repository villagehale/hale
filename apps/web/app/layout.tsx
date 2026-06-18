import type { Metadata, Viewport } from 'next';
import { Fraunces, Nunito } from 'next/font/google';
import './globals.css';

const fraunces = Fraunces({
  subsets: ['latin'],
  variable: '--font-display',
  display: 'swap',
  axes: ['opsz', 'SOFT', 'WONK'],
});

const nunito = Nunito({
  subsets: ['latin'],
  variable: '--font-body',
  display: 'swap',
  weight: ['400', '500', '600', '700'],
});

export const metadata: Metadata = {
  title: 'Hale · the village your family lost',
  description:
    "Hale is the village your family lost, rebuilt through AI — across every stage of childhood. It finds the genuinely good local things to do, matched to your child, and makes them happen: registering, calendar, reminders, gear. Your family's data stays in Canada.",
};

export const viewport: Viewport = {
  themeColor: '#01204F',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${fraunces.variable} ${nunito.variable}`}>
      <body>{children}</body>
    </html>
  );
}
