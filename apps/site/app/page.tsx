import {
  Cat,
  Crescent,
  GrainOverlay,
  ParentAndHouse,
  Sapling,
  Seed,
  Sprout,
  Sun,
  Tree,
} from '~/components/illos';
import { HeroScene } from '~/components/hero-scene';
import { WaitlistForm } from '~/components/waitlist-form';

const DAY = [
  {
    arc: 'Dawn',
    stage: 'Newborn',
    task: 'Noticed the diaper box was three days from empty and drafted a reorder — you tapped approve before the kettle boiled.',
  },
  {
    arc: 'Midday',
    stage: 'Toddler',
    task: 'Read the daycare email about the closure day, found the gap in your calendar, and drafted the reply asking grandma to cover.',
  },
  {
    arc: 'Dusk',
    stage: 'Child',
    task: 'Saw the soccer-registration deadline buried in a newsletter and surfaced it with the form half-filled from what it already knew.',
  },
  {
    arc: 'Night',
    stage: 'Teenager',
    task: 'Kept the family calendar honest and the permission forms signed — and gave your teen their own privacy: you see summaries, never their messages.',
  },
] as const;

const LADDER = [
  {
    shape: <Seed style={{ height: 64, width: 'auto' }} />,
    title: 'Connect',
    body: 'Gmail or Outlook first. Your calendar second. Photos only when you trust Hearth with them.',
  },
  {
    shape: <Sprout style={{ height: 80, width: 'auto' }} />,
    title: 'Observe for 7 days',
    body: 'At first Hearth only watches. You see exactly what it sees — no drafts, no actions, no exceptions.',
  },
  {
    shape: <Sapling style={{ height: 92, width: 'auto' }} />,
    title: 'Draft, with approval',
    body: 'After a week it begins drafting replies, appointments, orders. You approve every single one.',
  },
  {
    shape: <Tree style={{ height: 96, width: 'auto' }} />,
    title: 'Autonomy, earned',
    body: 'After five clean approvals of one kind of task, Hearth may handle that kind on its own. Revoke any time, with one tap.',
  },
] as const;

const TIERS = [
  {
    name: 'Free',
    price: 'Always free',
    line: 'Hearth observes and drafts — every stage, every child. It watches, it waits, it asks before it acts.',
    panel: 'panel-oat',
  },
  {
    name: 'Hearth Plus',
    price: '$24/mo CAD',
    line: 'Once it has earned your trust, Hearth acts on its own for the tasks you have approved. The same care, fewer taps.',
    panel: 'panel-apricot-tint',
  },
  {
    name: 'Hearth Family',
    price: '$49/mo CAD',
    line: 'Everything in plus, with supply autopilot and the portal automation — daycare, pediatric, school forms — handled.',
    panel: 'panel-sky-tint',
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
      <GrainOverlay />

      {/* ── 1 · Hero — one calm day ─────────────────────────────────────── */}
      <header className="shell flex items-center justify-between pt-8 pb-2">
        <span className="font-display text-2xl" style={{ fontVariationSettings: '"opsz" 96, "SOFT" 50, "WONK" 0' }}>
          Hearth
        </span>
        <span className="pill pill-apricot">research preview</span>
      </header>

      <section className="shell pt-10 sm:pt-16 lg:pt-20 pb-20 lg:pb-28">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-12 lg:gap-x-16 items-center">
          <div className="lg:col-span-7 rise rise-1">
            <HeroScene />
            <p className="meta mt-4 max-w-md">
              The kitten by the door is Hearth. It is a cat — its life is about as
              long as a childhood, and it grows up right alongside your kid:
              newborn, toddler, child, teenager.
            </p>
          </div>

          <div className="lg:col-span-5 rise rise-2">
            <h1>
              Hearth <span className="wonk">holds</span> the small things, so you
              can hold the baby.
            </h1>
            <p className="mt-6 text-lg" style={{ color: 'var(--color-slate-green)', lineHeight: 1.6 }}>
              A calm, careful companion for newborn families in Canada. It tends
              the daily admin in the background — and never acts until you have
              said it may.
            </p>
            <div className="mt-8">
              <a href="#waitlist" className="btn-primary">
                Request early access
              </a>
            </div>
          </div>
        </div>
      </section>

      {/* ── 2 · The plain-language promise band ─────────────────────────── */}
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
            Hearth watches the inbox, the calendar, the photos, and the small
            devices that already log your baby&rsquo;s life — the pediatric
            office, the daycare waitlist, the diaper subscription, the
            grandparent who keeps asking how she slept — and quietly does the
            easy ninety percent.
          </p>
        </div>
      </section>

      {/* ── 3 · A day with Hearth — the four-stages story ─────────────────── */}
      <section className="shell pb-20 lg:pb-28">
        <div className="max-w-2xl mb-12 lg:mb-16">
          <span className="eyebrow">A day with Hearth</span>
          <h2 className="mt-3">
            One day, one childhood — the same gentle arc.
          </h2>
          <p className="mt-5 meta max-w-xl" style={{ fontSize: '1rem', color: 'var(--color-slate-green)' }}>
            From dawn to night, and from newborn to teenager, Hearth handles one
            small thing at a time. The thesis is the cat&rsquo;s: it grows up
            alongside your kid.
          </p>
        </div>

        <ol className="relative grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-x-10 gap-y-14">
          {DAY.map((moment, i) => (
            <li key={moment.arc} className={`rise rise-${i + 1}`}>
              <div className="flex items-end gap-3 h-[120px]" aria-hidden>
                {i === 0 && <Sun style={{ height: 72, width: 'auto' }} />}
                {i === 1 && <Cat age="young" style={{ height: 110, width: 'auto' }} />}
                {i === 2 && <Cat age="adult" style={{ height: 118, width: 'auto' }} />}
                {i === 3 && <Cat age="senior" style={{ height: 122, width: 'auto' }} />}
              </div>
              <div className="mt-5 flex items-baseline gap-3">
                <span className="font-display text-xl" style={{ color: 'var(--color-apricot-deep)' }}>
                  {moment.arc}
                </span>
                <span className="eyebrow">{moment.stage}</span>
              </div>
              <p className="mt-3" style={{ color: 'var(--color-slate-green)', lineHeight: 1.55 }}>
                {moment.task}
              </p>
            </li>
          ))}
        </ol>
      </section>

      {/* ── 4 · Trust, earned slowly ────────────────────────────────────── */}
      <section className="shell pb-20 lg:pb-28">
        <div className="max-w-2xl mb-12 lg:mb-16">
          <span className="eyebrow">Trust, earned slowly</span>
          <h2 className="mt-3">
            Autonomy is grown, never assumed.
          </h2>
        </div>

        <ol className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-x-10 gap-y-12 items-end">
          {LADDER.map((step, i) => (
            <li key={step.title} className={`rise rise-${i + 1}`}>
              <div className="flex items-end h-[100px]" aria-hidden>
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

      {/* ── 5 · Three sizes of help (pricing) ───────────────────────────── */}
      <section className="shell pb-20 lg:pb-28">
        <div className="max-w-2xl mb-12 lg:mb-16">
          <span className="eyebrow">Three sizes of help</span>
          <h2 className="mt-3">
            Start free. Pay only when Hearth has earned it.
          </h2>
          <p className="mt-5 meta max-w-xl" style={{ fontSize: '1rem', color: 'var(--color-slate-green)' }}>
            Every plan covers every stage and every child. The paid tiers simply
            let Hearth do more of the work itself. Monthly, or a little less per
            month if you pay yearly.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 lg:gap-8">
          {TIERS.map((tier, i) => (
            <div
              key={tier.name}
              className={`${tier.panel} px-8 py-10 flex flex-col rise rise-${i + 1}`}
            >
              <h3 className="font-display" style={{ fontSize: '1.65rem' }}>
                {tier.name}
              </h3>
              <p
                className="mt-2 font-display"
                style={{ fontSize: '1.25rem', color: 'var(--color-apricot-deep)' }}
              >
                {tier.price}
              </p>
              <p className="mt-5" style={{ color: 'var(--color-spruce)', lineHeight: 1.6 }}>
                {tier.line}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* ── 6 · Hearth will never — the inverted night section ────────────── */}
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
              Hearth will never.
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

      {/* ── 7 · A note from the maker ───────────────────────────────────── */}
      <section className="shell py-24 lg:py-32">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-10 lg:gap-x-16 items-center">
          <div className="lg:col-span-3 flex justify-center lg:justify-start">
            <ParentAndHouse style={{ width: 'clamp(140px, 22vw, 180px)', height: 'auto' }} />
          </div>
          <div className="lg:col-span-9">
            <span className="eyebrow">A note from the maker</span>
            <p
              className="mt-5 font-display max-w-3xl"
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

      {/* ── 8 · Waitlist close ──────────────────────────────────────────── */}
      <section id="waitlist" className="shell pb-24 lg:pb-32">
        <div className="panel-oat px-8 py-14 sm:px-14 sm:py-20 lg:px-20">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-10 lg:gap-x-16 items-center">
            <div className="lg:col-span-6">
              <h2>Hold the baby. Hearth holds the rest.</h2>
              <p className="mt-6 text-lg" style={{ color: 'var(--color-slate-green)', lineHeight: 1.6 }}>
                Free for one year in exchange for honest feedback. Canadian data
                residency. PIPEDA + Quebec Law 25 + CASL compliant by default.
                Leave any time and take your family graph with you.
              </p>
            </div>
            <div className="lg:col-span-6">
              <WaitlistForm />
            </div>
          </div>
        </div>
      </section>

      <footer className="shell pb-12 flex flex-wrap items-center justify-between gap-4">
        <p className="meta">Hearth · Toronto · Canada · a research preview</p>
        <p className="meta flex items-center gap-2">
          set in Fraunces &amp; Nunito
          <Sun style={{ width: 18, height: 18 }} />
        </p>
      </footer>
    </main>
  );
}
