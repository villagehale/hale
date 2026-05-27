import Link from 'next/link';
import { ReadingColumn } from '~/components/mira/reading-column';
import { Seal } from '~/components/mira/seal';
import { LongDate } from '~/components/mira/long-date';

export default function LandingPage() {
  return (
    <>
      <div className="pointer-events-none fixed top-8 right-8 z-10">
        <Seal />
      </div>

      <ReadingColumn>
        <header className="letter-rise letter-rise-1 mb-20">
          <LongDate />
        </header>

        <h1 className="letter-rise letter-rise-2 mb-16 font-display italic">
          a quiet ai
          <br />
          for the first year.
        </h1>

        <div className="letter-rise letter-rise-3 space-y-7 text-[1.08rem] leading-[1.75] text-ink-soft">
          <p>
            mira is for the first twelve months of your child's life. you connect your email,
            your calendar, your photos. mira watches quietly. it reads the pediatric office,
            the daycare waitlist, the diaper subscription, the grandparent's question about
            what age was first solids.
          </p>
          <p>
            for the first week it just listens. then it begins drafting replies, scheduling
            checkups, filling forms — always asking before it acts, until you trust it
            not to.
          </p>
          <p>
            every morning you receive one short letter of what's been handled, and one short
            note of what still needs you. nothing else.
          </p>
        </div>

        <hr className="hairline letter-rise letter-rise-4 my-20" />

        <section className="letter-rise letter-rise-5 mb-20">
          <h2 className="mb-8 font-display">what mira does today</h2>
          <ul className="space-y-5 text-[1.05rem] text-ink-soft">
            <li>— confirms pediatric appointments. fills the pre-visit forms.</li>
            <li>— reorders diapers, formula, wipes from your usual sources.</li>
            <li>— files parental leave paperwork. ei, provincial top-ups, employer hr.</li>
            <li>— drafts replies to teachers, clinics, daycares in your voice.</li>
            <li>
              — answers your questions about sleep, feeding, milestones, grounded in
              health canada guidelines and named frameworks.
            </li>
          </ul>
        </section>

        <hr className="hairline letter-rise letter-rise-6 my-20" />

        <section className="letter-rise letter-rise-7 mb-24 space-y-8">
          <h2 className="font-display">join the early cohort</h2>
          <p className="text-[1.05rem] text-ink-soft">
            ten toronto families in the first quarter. the product is free for one year in
            exchange for honest feedback. canadian data residency, pipeda compliant.
          </p>

          <div className="flex flex-wrap items-center gap-6">
            <Link href="/sign-up" className="btn-ink">
              request an invite
            </Link>
            <Link href="/digest" className="btn-ghost travel-underline">
              see what a digest looks like →
            </Link>
          </div>
        </section>

        <footer className="border-t border-hairline pt-10 pb-6">
          <p className="hand text-ink-quiet">with care,</p>
          <p className="hand text-ink mt-1">mira</p>
          <p className="meta mt-8 text-ink-quiet">
            mira · toronto · ca · pipeda + quebec law 25 compliant
          </p>
        </footer>
      </ReadingColumn>
    </>
  );
}
