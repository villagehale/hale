import Link from 'next/link';

export default function AuthedLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen">
      <header className="border-b border-hairline">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-8 py-6">
          <Link href="/digest" className="font-serif text-xl">
            mira
          </Link>
          <nav className="flex items-center gap-6 text-sm">
            <Link href="/digest" className="smallcaps">
              digest
            </Link>
            <Link href="/drafts" className="smallcaps">
              drafts
            </Link>
            <Link href="/coach" className="smallcaps">
              coach
            </Link>
            <Link href="/settings" className="smallcaps">
              settings
            </Link>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-8 py-12">{children}</main>
    </div>
  );
}
