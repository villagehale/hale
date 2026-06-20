import Link from 'next/link';
import { LogoMark } from '~/components/hale/logo-mark';
import { ThemeToggle } from '~/components/hale/theme-toggle';

export default function PrivacyPage() {
  return (
    <main className="min-h-screen bg-linen">
      <header className="shell flex items-center justify-between pt-8 pb-2">
        <Link href="/" className="flex items-center gap-3">
          <LogoMark size={32} />
          <span className="font-display text-2xl font-semibold">Hale</span>
        </Link>
        <ThemeToggle />
      </header>

      <section className="shell pt-16 pb-24 max-w-2xl">
        <span className="eyebrow">legal</span>
        <h1 className="mt-4 font-display">Privacy Policy</h1>
        <p className="mt-8 text-lg text-slate-green leading-relaxed">
          The full Privacy Policy is being finalized. This is a placeholder while
          the legal copy is prepared. Your family&rsquo;s data stays in Canada
          (PIPEDA · Law 25 · CASL compliant by default).
        </p>
        <p className="mt-4 meta">
          <Link href="/terms" className="link">
            Terms of Service
          </Link>
        </p>
      </section>
    </main>
  );
}
