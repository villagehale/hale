import Link from 'next/link';
import { Marquee } from '~/components/haru/marquee';

export default function LandingPage() {
  return (
    <main className="relative bg-bone">
      {/* ── Running head — like the top of an open book ─────────────────── */}
      <header className="shell flex items-baseline justify-between pt-6 pb-4 border-b border-rule">
        <span className="font-display text-xl">haru</span>
        <div className="hidden sm:flex items-baseline gap-6 text-faded">
          <span className="eyebrow">vol. one · toronto edition</span>
          <span className="eyebrow tabular">mmxxvi</span>
        </div>
        <Link href="/digest" className="btn-ghost">
          read a sample digest →
        </Link>
      </header>

      {/* ── Title page ──────────────────────────────────────────────────── */}
      <section className="shell pt-16 sm:pt-24 lg:pt-32 pb-16 lg:pb-24">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-12 lg:gap-x-12">
          <div className="lg:col-span-2 rise rise-1">
            <span className="eyebrow">folio i</span>
            <p className="meta mt-2">an almanac<br />for one family</p>
          </div>

          <div className="lg:col-span-10 rise rise-2">
            <h1 className="font-display leading-[0.96]">
              <span className="block">a household</span>
              <span className="block">that <span className="text-madder">remembers</span></span>
              <span className="block">for you.</span>
            </h1>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-8 lg:gap-x-12 mt-16 lg:mt-24">
          <div className="lg:col-span-3 lg:col-start-3 rise rise-3">
            <span className="eyebrow">what haru does</span>
            <p className="meta mt-3">est. 2026 · canada</p>
          </div>
          <div className="lg:col-span-7 rise rise-4">
            <p className="text-xl lg:text-[1.45rem] leading-snug text-slate dropcap">
              Haru watches your inbox, your calendar, your photos, and the small
              devices that already log your baby's life. It reads the pediatric
              office, the daycare waitlist, the diaper subscription, the
              grandparent who keeps asking how she slept — and quietly does the
              easy ninety percent so you can hold your baby for the hard ten.
            </p>
          </div>
        </div>
      </section>

      {/* ── Topic ticker (small printer's diamonds, calm cadence) ──────── */}
      <Marquee
        items={[
          'pediatric scheduling',
          'parental-leave paperwork',
          'supply reorder',
          'photo curation',
          'milestone tracking',
          'sleep coaching',
          'daycare admin',
          'co-parent coordination',
        ]}
      />

      {/* ── Chapter: the four steps ──────────────────────────────────────── */}
      <section className="shell py-20 lg:py-32">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-12 lg:gap-x-12">
          <div className="lg:col-span-3">
            <span className="eyebrow">chapter one</span>
            <h2 className="mt-5 font-display">
              trust, earned in four steps.
            </h2>
            <p className="meta mt-6">read in order</p>
          </div>

          <div className="lg:col-span-9 grid grid-cols-1 md:grid-cols-2 gap-x-10 gap-y-12">
            {[
              {
                folio: 'i',
                title: 'connect',
                body: "Gmail or Outlook first. Apple or Google calendar second. Photos when you trust me.",
              },
              {
                folio: 'ii',
                title: 'observe',
                body: 'For seven days I only watch. You see what I see — no drafts, no actions, no exceptions.',
              },
              {
                folio: 'iii',
                title: 'draft',
                body: "After seven days I start drafting replies, appointments, orders. You approve every one.",
              },
              {
                folio: 'iv',
                title: 'autonomy',
                body: 'After five clean approvals for a kind of task, I act on my own for that kind. You can revoke any time, with one tap.',
              },
            ].map((step) => (
              <article key={step.folio} className="border-t border-rule pt-6">
                <div className="flex items-baseline justify-between">
                  <span className="folio">{step.folio}</span>
                  <span className="eyebrow">step</span>
                </div>
                <h3 className="mt-4 font-display text-[2rem] leading-tight">
                  {step.title}
                </h3>
                <p className="mt-4 text-slate leading-relaxed">{step.body}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* ── Chapter: never ──────────────────────────────────────────────── */}
      <section className="bg-iron text-bone py-20 lg:py-32 border-y border-iron">
        <div className="shell grid grid-cols-1 lg:grid-cols-12 gap-y-12 lg:gap-x-12">
          <div className="lg:col-span-3">
            <span className="eyebrow" style={{ color: 'rgba(244,240,232,0.55)' }}>
              chapter two
            </span>
            <p className="mt-3 meta" style={{ color: 'rgba(244,240,232,0.55)' }}>
              the promises
            </p>
          </div>

          <div className="lg:col-span-9">
            <h2 className="font-display" style={{ color: 'var(--color-bone)' }}>
              haru will <span className="text-madder">never</span>.
            </h2>
            <ul className="mt-12 divide-y" style={{ borderColor: 'rgba(244,240,232,0.18)' }}>
              {[
                'give medical advice — only your pediatrician will',
                'send anything to anyone you have not greenlit',
                'spend more than your per-action cap without asking',
                'share your child with a recipient you have not approved',
                'store data outside canada',
                'sell your family graph to anyone, for any price',
              ].map((item, idx) => (
                <li
                  key={item}
                  className="flex gap-8 items-baseline py-5 text-lg lg:text-xl"
                  style={{ borderColor: 'rgba(244,240,232,0.18)', borderTopWidth: idx === 0 ? '1px' : 0, borderBottomWidth: '1px' }}
                >
                  <span className="folio tabular" style={{ color: 'rgba(244,240,232,0.45)', minWidth: '2rem' }}>
                    {String(idx + 1).padStart(2, '0')}
                  </span>
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      {/* ── Pull quote ──────────────────────────────────────────────────── */}
      <section className="shell py-20 lg:py-28">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-8 lg:gap-x-12 items-end">
          <div className="lg:col-span-3">
            <span className="eyebrow">a note from the maker</span>
          </div>
          <div className="lg:col-span-9">
            <blockquote className="pullquote max-w-[42rem]">
              I built haru because my partner and I were drowning in admin while
              trying to be present for our newborn. The job was too small for a
              nanny, too tedious for love, too important to fumble. A household
              needs an almanac, not another app.
            </blockquote>
            <p className="mt-6 meta">— founder · barton · toronto</p>
          </div>
        </div>
      </section>

      {/* ── CTA / colophon ──────────────────────────────────────────────── */}
      <section className="shell py-20 lg:py-32 border-t border-rule">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-10 lg:gap-x-12 items-end">
          <div className="lg:col-span-7">
            <span className="eyebrow">enrolment is open</span>
            <h2 className="mt-5 font-display">
              join the early cohort.<br />
              <span className="text-madder">ten</span> toronto families.
            </h2>
            <p className="mt-6 text-lg text-slate max-w-xl">
              Free for one year in exchange for honest feedback. Canadian data
              residency. PIPEDA + Quebec Law 25 + CASL compliant by default.
              You can leave at any time and take your family graph with you.
            </p>
          </div>

          <div className="lg:col-span-5 lg:items-end flex flex-col gap-3">
            <Link href="/onboarding" className="btn-primary">
              request an invitation →
            </Link>
            <Link href="/digest" className="btn-ghost">
              or read a sample digest
            </Link>
          </div>
        </div>
      </section>

      <footer className="shell border-t border-rule py-10 flex flex-wrap items-baseline justify-between gap-y-4 text-faded">
        <p className="meta">colophon · haru · toronto · canada · est. 2026</p>
        <p className="meta">set in source serif 4 + geist · printed for one family at a time</p>
      </footer>
    </main>
  );
}
