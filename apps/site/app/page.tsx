import {
  Crescent,
  GrainOverlay,
  ParentAndHouse,
  Sapling,
  SeaTurtle,
  Seed,
  Sprout,
  Sun,
  Tree,
} from '~/components/illos';
import { HeroScene } from '~/components/hero-scene';
import { WaitlistForm } from '~/components/waitlist-form';

const WEEK = [
  {
    arc: 'Newborn',
    stage: 'the first months',
    task: 'A water-babies class two streets over, a quiet drop-in for new parents on Thursday — found, held on your calendar, and the gentle reminder that this is normal, you are doing fine.',
  },
  {
    arc: 'Toddler',
    stage: 'finding the world',
    task: 'Library story-time, the good Montessori with a spot opening, the park festival on Saturday — surfaced for their age, with the registration started and the bag-list ready.',
  },
  {
    arc: 'Child',
    stage: 'growing into it',
    task: 'The soccer season that fits your week, the art class they would actually love, the field-trip form due Friday — signed, paid within your cap, and on the calendar before it slips.',
  },
  {
    arc: 'Teenager',
    stage: 'almost grown',
    task: 'The maker-space, the volunteer hours, the permission slips kept honest — and their own privacy held: you see what kind of thing, never their messages.',
  },
] as const;

const LADDER = [
  {
    shape: <Seed style={{ height: 64, width: 'auto' }} />,
    title: 'Connect',
    body: 'Your inbox first. Your calendar second. Photos only when you trust Hale with them.',
  },
  {
    shape: <Sprout style={{ height: 80, width: 'auto' }} />,
    title: 'Observe for 7 days',
    body: 'At first Hale only watches and learns your family — the ages, the rhythm, the village you already have. No drafts, no actions, no exceptions.',
  },
  {
    shape: <Sapling style={{ height: 92, width: 'auto' }} />,
    title: 'Draft, with approval',
    body: 'After a week it begins drafting replies, appointments, orders. You approve every single one.',
  },
  {
    shape: <Tree style={{ height: 96, width: 'auto' }} />,
    title: 'Autonomy, earned',
    body: 'After five clean approvals of one kind of task, Hale may handle that kind on its own. Revoke any time, with one tap.',
  },
] as const;

const TIERS = [
  {
    name: 'Free',
    price: 'Always free',
    line: 'Hale finds your kid’s good local week and drafts the rest — every stage, every child. It watches, it waits, it asks before it acts.',
    panel: 'panel-oat',
  },
  {
    name: 'Hale Plus',
    price: '$24/mo CAD',
    line: 'Once it has earned your trust, Hale makes it happen on its own — registers you, holds the date, reorders the gear. The same care, fewer taps.',
    panel: 'panel-apricot-tint',
  },
  {
    name: 'Hale Family',
    price: '$49/mo CAD',
    line: 'Everything in plus, with the portals on autopilot — daycare, pediatric, school, the registration forms — handled before they slip.',
    panel: 'panel-sky-tint',
  },
] as const;

const NEVER = [
  'give medical advice — only your pediatrician will',
  'send anything to anyone you have not greenlit',
  'spend more than your per-action cap without asking',
  'share your child with a recipient you have not approved',
  'store your family’s data outside Canada',
  'sell your family’s data to anyone, for any price',
] as const;

export default function LandingPage() {
  return (
    <main className="relative">
      <GrainOverlay />

      {/* ── 1 · Hero — one calm day ─────────────────────────────────────── */}
      <header className="shell flex items-center justify-between pt-8 pb-2">
        <span className="font-display text-2xl" style={{ fontVariationSettings: '"opsz" 96, "SOFT" 50, "WONK" 0' }}>
          Hale
        </span>
        <span className="pill pill-apricot">research preview</span>
      </header>

      <section className="shell pt-10 sm:pt-16 lg:pt-20 pb-20 lg:pb-28">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-12 lg:gap-x-16 items-center">
          <div className="lg:col-span-7 rise rise-1">
            <HeroScene />
            <p className="meta mt-4 max-w-md">
              The small companion by the door is Hale. It is built to live about
              as long as a childhood, and it grows up right alongside your kid:
              newborn, toddler, child, teenager.
            </p>
          </div>

          <div className="lg:col-span-5 rise rise-2">
            <h1>
              Hale is the <span className="wonk">village</span> your family
              lost.
            </h1>
            <p className="mt-6 text-lg" style={{ color: 'var(--color-slate-green)', lineHeight: 1.6 }}>
              It finds the genuinely good local things to do — the class, the
              story-time, the festival — matched to your kid’s age and stage,
              and then makes it happen. A calm companion that knows the way, and
              never acts until you have said it may.
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
            Once, a family had a village — elders who knew which class was worth
            it, neighbors who carried the small things, a grandmother who
            said this is normal, you are doing fine. Hale rebuilds that village:
            it discovers the good local week for your kid, and then registers
            you, books it, reminds you, reorders the gear &mdash; quietly, the way
            the village used to.
          </p>
        </div>
      </section>

      {/* ── 3 · The good local week — the four-stages story ─────────────── */}
      <section className="shell pb-20 lg:pb-28">
        <div className="max-w-2xl mb-12 lg:mb-16">
          <span className="eyebrow">The good local week</span>
          <h2 className="mt-3">
            One childhood, every stage — the same gentle arc.
          </h2>
          <p className="mt-5 meta max-w-xl" style={{ fontSize: '1rem', color: 'var(--color-slate-green)' }}>
            From the first months to almost grown, Hale finds the genuinely good
            things near you and brings them within reach — one at a time. It
            grows up alongside your kid, and the week grows with them.
          </p>
        </div>

        <ol className="relative grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-x-10 gap-y-14">
          {WEEK.map((moment, i) => (
            <li key={moment.arc} className={`rise rise-${i + 1}`}>
              <div className="flex items-end gap-3 h-[120px]" aria-hidden>
                {i === 0 && <Sun style={{ height: 72, width: 'auto' }} />}
                {i === 1 && <SeaTurtle age="young" style={{ height: 110, width: 'auto' }} />}
                {i === 2 && <SeaTurtle age="adult" style={{ height: 118, width: 'auto' }} />}
                {i === 3 && <SeaTurtle age="elder" style={{ height: 122, width: 'auto' }} />}
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
            Start free. Pay only when Hale has earned it.
          </h2>
          <p className="mt-5 meta max-w-xl" style={{ fontSize: '1rem', color: 'var(--color-slate-green)' }}>
            Every plan covers every stage and every child. The paid tiers simply
            let Hale do more of the work itself. Monthly, or a little less per
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

      {/* ── 6 · Hale will never — the inverted night section ────────────── */}
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
              Hale will never.
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
              My partner and I were raising a kid far from the village our own
              parents had — no elders down the street, no one who just knew which
              class was worth it or that this hard week was normal. The job was
              too big to carry alone, too tender to outsource. So I built a quiet
              companion to be that village again — finding the good things,
              making them happen, and growing up right alongside the kid.
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
              <h2>Find your family’s village.</h2>
              <p className="mt-6 text-lg" style={{ color: 'var(--color-slate-green)', lineHeight: 1.6 }}>
                Free for one year in exchange for honest feedback. Your family’s
                data stays in Canada. PIPEDA + Quebec Law 25 + CASL compliant by
                default. Leave any time and take your family graph with you.
              </p>
            </div>
            <div className="lg:col-span-6">
              <WaitlistForm />
            </div>
          </div>
        </div>
      </section>

      <footer className="shell pb-12 flex flex-wrap items-center justify-between gap-4">
        <p className="meta">Hale · Toronto · Canada · a research preview</p>
        <p className="meta flex items-center gap-2">
          set in Fraunces &amp; Nunito
          <Sun style={{ width: 18, height: 18 }} />
        </p>
      </footer>
    </main>
  );
}
