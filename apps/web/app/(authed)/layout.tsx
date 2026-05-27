import Link from 'next/link';
import { Seal } from '~/components/mira/seal';

const NAV = [
  { href: '/digest', label: 'digest' },
  { href: '/drafts', label: 'drafts' },
  { href: '/coach', label: 'coach' },
  { href: '/connect', label: 'connect' },
  { href: '/settings', label: 'settings' },
] as const;

export default function AuthedLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen">
      <div className="pointer-events-none fixed top-6 right-6 z-10">
        <Seal />
      </div>

      <header className="reading-column pt-10 pb-2">
        <div className="flex items-baseline justify-between gap-6">
          <Link href="/digest" className="font-display text-2xl italic travel-underline">
            mira
          </Link>
          <nav className="flex items-baseline gap-6">
            {NAV.map((item) => (
              <Link key={item.href} href={item.href} className="smallcaps travel-underline">
                {item.label}
              </Link>
            ))}
          </nav>
        </div>
      </header>

      {children}
    </div>
  );
}
