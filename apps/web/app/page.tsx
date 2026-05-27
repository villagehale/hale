import Link from 'next/link';
import { Marquee } from '~/components/mira/marquee';

export default function LandingPage() {
  return (
    <main className="relative">
      {/* ── HERO ─────────────────────────────────────────────────────────── */}
      <section className="shell pt-12 sm:pt-16 lg:pt-24 pb-20 lg:pb-32">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-12 lg:gap-x-12 items-end">
          <div className="lg:col-span-2 rise rise-1">
            <span className="eyebrow">№ 001 · toronto</span>
          </div>

          <div className="lg:col-span-10 rise rise-2">
            <h1 className="font-display leading-[0.92] tracking-tight">
              <span className="block">a household</span>
              <span className="block text-copper">platform</span>
              <span className="block">for the first</span>
              <span className="block">year, and the next eighteen.</span>
            </h1>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-8 lg:gap-x-12 mt-16 lg:mt-24">
          <div className="lg:col-span-3 lg:col-start-3 rise rise-3">
            <span className="eyebrow">what mira does</span>
          </div>
          <div className="lg:col-span-7 rise rise-4">
            <p className="text-xl lg:text-2xl leading-snug text-ink-soft">
              mira watches your inbox, your calendar, your photos, and the small
              devices that already log your kid's life. it reads the pediatric
              office, the daycare waitlist, the diaper subscription, the
              grandparent who keeps asking how she slept. then it does the easy
              ninety percent and asks you about the hard ten.
            </p>
          </div>
        </div>
      </section>

      {/* ── MARQUEE ROW ──────────────────────────────────────────────────── */}
      <section className="border-y border-hairline bg-cream-deep overflow-hidden">
        <Marquee
          items={[
            'pediatric scheduling',
            'parental leave paperwork',
            'supply reorder',
            'photo curation',
            'milestone tracking',
            'sleep coaching',
            'daycare admin',
            'co-parent coordination',
          ]}
        />
      </section>

      {/* ── HOW IT WORKS ──────────────────────────────────────────────────── */}
      <section className="shell py-20 lg:py-32">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-12 lg:gap-x-12">
          <div className="lg:col-span-3">
            <span className="eyebrow">how it works</span>
            <h2 className="mt-6 font-display text-copper">
              trust,
              <br />
              earned in
              <br />
              four steps.
            </h2>
          </div>

          <div className="lg:col-span-9 grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-12">
            {[
              {
                folio: '01',
                title: 'connect',
                body: 'gmail or outlook first. apple or google calendar second. photos when you trust me.',
              },
              {
                folio: '02',
                title: 'observe',
                body: 'for seven days i only watch. you see what i see — no drafts, no actions.',
              },
              {
                folio: '03',
                title: 'draft',
                body: "after seven days i start drafting replies, appointments, orders. you approve every one.",
              },
              {
                folio: '04',
                title: 'autonomy',
                body: 'after five clean approvals for a kind of task, i act on my own for that kind. you can revoke any time.',
              },
            ].map((step) => (
              <article key={step.folio} className="border-t border-hairline pt-6">
                <span className="folio">{step.folio}</span>
                <h3 className="mt-3 font-display text-2xl">{step.title}</h3>
                <p className="mt-3 text-ink-soft leading-relaxed">{step.body}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* ── WHAT MIRA WILL NEVER DO ──────────────────────────────────────── */}
      <section className="bg-ink text-cream py-20 lg:py-32">
        <div className="shell grid grid-cols-1 lg:grid-cols-12 gap-y-12 lg:gap-x-12">
          <div className="lg:col-span-3">
            <span className="eyebrow text-cream/60">the promises</span>
          </div>
          <div className="lg:col-span-9">
            <h2 className="font-display text-cream">
              mira will <em className="text-copper not-italic">never</em>
            </h2>
            <ul className="mt-12 space-y-6 text-xl leading-snug">
              {[
                'give medical advice — only your pediatrician will',
                'send anything to anyone you have not greenlit',
                'spend more than your per-action cap without asking',
                'share your child with a recipient you have not approved',
                'store data outside canada',
                'sell your family graph to anyone, for any price',
              ].map((item) => (
                <li key={item} className="flex gap-6 items-start">
                  <span className="folio text-cream/40 pt-2">·</span>
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      {/* ── CTA ──────────────────────────────────────────────────────────── */}
      <section className="shell py-20 lg:py-32">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-8 lg:gap-x-12 items-end">
          <div className="lg:col-span-7">
            <h2 className="font-display">
              join the early cohort of ten toronto families.
            </h2>
            <p className="mt-6 text-lg text-ink-soft">
              free for one year in exchange for honest feedback. canadian data
              residency. pipeda + quebec law 25 + casl compliant by default.
            </p>
          </div>

          <div className="lg:col-span-5 flex flex-col gap-4 lg:items-end">
            <Link href="/onboarding" className="btn-primary">
              request an invite
            </Link>
            <Link href="/digest" className="btn-ghost">
              preview a digest →
            </Link>
          </div>
        </div>
      </section>

      <footer className="shell border-t border-hairline py-10 flex flex-wrap items-baseline justify-between gap-y-4 text-ink-mute">
        <p className="meta">mira · toronto · canada</p>
        <p className="meta">№ 001 · year one</p>
      </footer>
    </main>
  );
}
