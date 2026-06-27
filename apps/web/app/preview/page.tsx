import Link from 'next/link';
import { LogoMark } from '~/components/hale/logo-mark';
import { ThemeToggle } from '~/components/hale/theme-toggle';
import { PreviewIntake } from './intake';

/**
 * The PRE-AUTH value preview — a PUBLIC, unauthenticated route (rule #1). The
 * landing site links here ("See what Hale finds for you"); it shows a genuinely
 * personalized sample of local activities BEFORE the signup wall, then hands off
 * to sign-in → onboarding. No child-identifying data is collected or persisted
 * here — see intake.tsx and /api/preview for the privacy contract.
 */
export default function PreviewPage() {
  return (
    <div className="min-h-[100dvh] bg-linen">
      <header className="shell flex items-center justify-between pt-6 pb-4 border-b border-rule">
        <Link href="/" className="flex items-center gap-3">
          <LogoMark size={32} />
          <span className="font-display text-2xl font-semibold leading-none">Hale</span>
        </Link>
        <div className="flex items-center gap-3">
          <span className="eyebrow hidden sm:inline">a preview</span>
          <ThemeToggle />
        </div>
      </header>

      <main className="shell pt-16 lg:pt-24 pb-24">
        <PreviewIntake />
      </main>
    </div>
  );
}
