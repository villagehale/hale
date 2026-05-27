import Link from 'next/link';

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
      <header className="reading-column pt-10 pb-2">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-3">
          <Link href="/digest" className="font-display text-2xl italic travel-underline">
            mira
          </Link>
          <nav className="flex flex-wrap items-baseline gap-x-5 gap-y-2">
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
