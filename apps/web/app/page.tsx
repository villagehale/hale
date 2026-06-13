import Link from 'next/link';
import { Cat, Crescent, House, Sapling, Seed, Sprout, Sun, Tree } from '~/components/illos';

const STEPS = [
  {
    shape: <Seed style={{ height: 56, width: 'auto' }} />,
    title: 'connect',
    body: 'Gmail or Outlook first. Your calendar second. Photos only when you trust haru with them.',
  },
  {
    shape: <Sprout style={{ height: 68, width: 'auto' }} />,
    title: 'observe',
    body: 'For seven days haru only watches. You see exactly what it sees — no drafts, no actions, no exceptions.',
  },
  {
    shape: <Sapling style={{ height: 80, width: 'auto' }} />,
    title: 'draft',
    body: 'After a week it begins drafting replies, appointments, orders. You approve every single one.',
  },
  {
    shape: <Tree style={{ height: 84, width: 'auto' }} />,
    title: 'autonomy',
    body: 'After five clean approvals of one kind of task, haru may handle that kind on its own. Revoke any time, with one tap.',
  },
] as const;

const NEVER = [
  'give medical advice — only your pediatrician will',
  'send anything to anyone you have not greenlit',
  'spend more than your per-action cap without asking',
  'share your child with a recipient you have not approved',
  'store your family’s data outside Canada',
  'sell your family graph to anyone, for any price',
] as const;

export default function LandingPage() {
  return (
    <main className="relative">
      {/* ── Running head ────────────────────────────────────────────────── */}
      <header className="shell flex items-center justify-between pt-8 pb-2">
        <span
          className="font-display text-2xl"
          style={{ fontVariationSettings: '"opsz" 96, "SOFT" 50, "WONK" 0' }}
        >
          haru
        </span>
        <Link href="/digest" className="btn-ghost">
          read a sample digest →
        </Link>
      </header>

      {/* ── Hero ────────────────────────────────────────────────────────── */}
      <section className="shell pt-12 sm:pt-16 lg:pt-20 pb-20 lg:pb-28">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-12 lg:gap-x-16 items-center">
          <div className="lg:col-span-7 rise rise-1">
            <div className="panel-oat px-8 py-12 sm:px-12 sm:py-16 flex items-end justify-center gap-6 flex-wrap" aria-hidden>
              <Sun style={{ height: 84, width: 'auto' }} />
              <House style={{ height: 110, width: 'auto' }} />
              <Cat age="kitten" style={{ height: 64, width: 'auto' }} />
            </div>
            <p className="meta mt-4 max-w-md">
              The kitten by the door is haru. It is a cat — its life is about as
              long as a childhood, and it grows up right alongside your kid:
              newborn, toddler, child, teenager.
            </p>
          </div>

          <div className="lg:col-span-5 rise rise-2">
            <h1>
              haru holds the small things, so you can hold the baby.
            </h1>
            <p
              className="mt-6 text-lg"
              style={{ color: 'var(--color-slate-green)', lineHeight: 1.6 }}
            >
              A calm, careful companion for newborn families in Canada. It tends
              the daily admin in the background — and never acts until you have
              said it may.
            </p>
            <div className="mt-8">
              <Link href="/onboarding" className="btn-primary">
                request an invitation
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* ── Plain-language promise band ─────────────────────────────────── */}
      <section className="shell pb-20 lg:pb-28">
        <div className="panel-oat px-8 py-14 sm:px-14 sm:py-20 lg:px-20 lg:py-24">
          <p
            className="font-display max-w-4xl"
            style={{
              fontSize: 'clamp(1.65rem, 3.4vw, 2.75rem)',
              lineHeight: 1.2,
              fontVariationSettings: '"opsz" 120, "SOFT" 50, "WONK" 0',
            }}
          >
            haru watches the inbox, the calendar, the photos, and the small
            devices that already log your baby&rsquo;s life — the pediatric
            office, the daycare waitlist, the diaper subscription, the
            grandparent who keeps asking how she slept — and quietly does the
            easy ninety percent.
          </p>
        </div>
      </section>

      {/* ── Trust, earned slowly ────────────────────────────────────────── */}
      <section className="shell pb-20 lg:pb-28">
        <div className="max-w-2xl mb-12 lg:mb-16">
          <span className="eyebrow">Trust, earned slowly</span>
          <h2 className="mt-3">Autonomy is grown, never assumed.</h2>
        </div>

        <ol className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-x-10 gap-y-12 items-end">
          {STEPS.map((step, i) => (
            <li key={step.title} className={`rise rise-${i + 1}`}>
              <div className="flex items-end h-[92px]" aria-hidden>
                {step.shape}
              </div>
              <h3 className="mt-5">{step.title}</h3>
              <p className="mt-3" style={{ color: 'var(--color-slate-green)', lineHeight: 1.55 }}>
                {step.body}
              </p>
            </li>
          ))}
        </ol>
      </section>

      {/* ── haru will never — the inverted night section ────────────────── */}
      <section
        className="py-24 lg:py-32"
        style={{ background: 'var(--color-spruce)', color: 'var(--color-on-spruce)' }}
      >
        <div className="shell grid grid-cols-1 lg:grid-cols-12 gap-y-12 lg:gap-x-16">
          <div className="lg:col-span-4">
            <span className="eyebrow" style={{ color: 'var(--color-on-spruce-soft)' }}>
              The promises
            </span>
            <h2 className="mt-3" style={{ color: 'var(--color-on-spruce)' }}>
              haru will never.
            </h2>
            <p className="mt-6" style={{ color: 'var(--color-on-spruce-soft)', lineHeight: 1.6, maxWidth: '24rem' }}>
              This is the compliance core. PIPEDA, Quebec Law 25, and Canadian
              data residency live here, not in fine print.
            </p>
          </div>

          <ul className="lg:col-span-8 flex flex-col gap-7">
            {NEVER.map((promise) => (
              <li key={promise} className="flex gap-4 items-start text-lg lg:text-xl">
                <span className="shrink-0 mt-1">
                  <Crescent style={{ width: 26, height: 26 }} />
                </span>
                <span style={{ lineHeight: 1.4 }}>{promise}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* ── A note from the maker ───────────────────────────────────────── */}
      <section className="shell py-24 lg:py-32">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-8 lg:gap-x-16 items-end">
          <div className="lg:col-span-3">
            <span className="eyebrow">A note from the maker</span>
          </div>
          <div className="lg:col-span-9">
            <p
              className="font-display max-w-3xl"
              style={{
                fontSize: 'clamp(1.4rem, 2.6vw, 2rem)',
                lineHeight: 1.32,
                fontVariationSettings: '"opsz" 110, "SOFT" 50, "WONK" 0',
              }}
            >
              My partner and I were drowning in admin while trying to be present
              for our newborn. The job was too small for a nanny, too tedious for
              love, too important to fumble. So I built a careful companion that
              tidies the small things while the family sleeps — and grows up with
              the kid, the way a good cat does.
            </p>
            <p className="mt-6 meta">— Barton, Toronto</p>
          </div>
        </div>
      </section>

      {/* ── CTA close ───────────────────────────────────────────────────── */}
      <section className="shell pb-24 lg:pb-32">
        <div className="panel-oat px-8 py-14 sm:px-14 sm:py-20 lg:px-20">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-10 lg:gap-x-16 items-center">
            <div className="lg:col-span-7">
              <h2>Hold the baby. haru holds the rest.</h2>
              <p className="mt-6 text-lg" style={{ color: 'var(--color-slate-green)', lineHeight: 1.6 }}>
                Free for one year in exchange for honest feedback. Canadian data
                residency. PIPEDA + Quebec Law 25 + CASL compliant by default.
                Leave any time and take your family graph with you.
              </p>
            </div>
            <div className="lg:col-span-5 flex flex-col gap-3">
              <Link href="/onboarding" className="btn-primary">
                request an invitation
              </Link>
              <Link href="/digest" className="btn-ghost">
                or read a sample digest
              </Link>
            </div>
          </div>
        </div>
      </section>

      <footer className="shell pb-12 flex flex-wrap items-center justify-between gap-4">
        <p className="meta">haru · Toronto · Canada · a research preview</p>
        <p className="meta flex items-center gap-2">
          set in Fraunces &amp; Nunito
          <Sun style={{ width: 18, height: 18 }} />
        </p>
      </footer>
    </main>
  );
}
