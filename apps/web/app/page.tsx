import Link from 'next/link';
import { redirect } from 'next/navigation';
import { auth } from '~/auth';
import { House, SeaTurtle, Sun } from '~/components/illos';
import { LogoMark } from '~/components/hale/logo-mark';
import { ThemeToggle } from '~/components/hale/theme-toggle';
import { authConfigured } from '~/lib/auth-config';

// authConfigured()/auth() read runtime secrets and the live session — never bake
// them at build time.
export const dynamic = 'force-dynamic';

export default async function LandingPage() {
  // A signed-in parent lands on their home, not the marketing front door.
  if (authConfigured()) {
    const session = await auth();
    if (session?.user?.id) {
      redirect('/home');
    }
  }

  return (
    <main className="relative">
      {/* ── Running head ────────────────────────────────────────────────── */}
      <header className="shell flex items-center justify-between pt-8 pb-2">
        <Link href="/" className="flex items-center gap-3">
          <LogoMark size={32} />
          <span className="font-display text-2xl font-semibold">Hale</span>
        </Link>
        <div className="flex items-center gap-5">
          <ThemeToggle />
          {authConfigured() ? (
            <Link href="/sign-in" className="btn-primary">
              sign in
            </Link>
          ) : null}
        </div>
      </header>

      {/* ── Village hero — the app front door ───────────────────────────── */}
      <section className="shell pt-12 sm:pt-16 lg:pt-24 pb-24 lg:pb-32">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-12 lg:gap-x-16 items-center">
          <div className="lg:col-span-7 rise rise-1">
            <div className="panel-oat px-8 py-12 sm:px-12 sm:py-16 flex items-end justify-center gap-6 flex-wrap" aria-hidden>
              <Sun style={{ height: 84, width: 'auto' }} />
              <House style={{ height: 110, width: 'auto' }} />
              <SeaTurtle age="hatchling" style={{ height: 64, width: 'auto' }} />
            </div>
            <p className="meta mt-4 max-w-md">
              Modern families raise children without the village that used to
              carry the load. Hale rebuilds it — quietly, alongside your kid,
              from newborn to teenager.
            </p>
          </div>

          <div className="lg:col-span-5 rise rise-2">
            <h1>Hale is the village your family lost.</h1>
            <p
              className="mt-6 text-lg"
              style={{ color: 'var(--color-slate-green)', lineHeight: 1.6 }}
            >
              It finds the good local things for your kid&rsquo;s age and stage —
              classes, story-times, the good Montessori, the festival down the
              street — and then makes them happen: signs you up, drops it on the
              calendar, reorders the gear. A calm coach reassures along the way.
            </p>
            <div className="mt-8 flex flex-col sm:flex-row gap-3">
              <Link href="/onboarding" className="btn-primary">
                set up your family
              </Link>
              <Link href="/sign-in" className="btn-ghost">
                sign in
              </Link>
            </div>
          </div>
        </div>
      </section>

      <footer className="shell pb-12 flex flex-wrap items-center justify-between gap-4">
        <p className="meta">Hale · your family&rsquo;s data stays in Canada · a research preview</p>
      </footer>
    </main>
  );
}
