import Link from 'next/link';

export default function LandingPage() {
  return (
    <main className="mx-auto max-w-2xl px-8 py-24">
      <div className="space-y-16">
        <header>
          <p className="smallcaps text-ink-quiet">mira · for new parents in canada</p>
          <h1 className="mt-6 font-serif text-5xl leading-tight">
            a quiet ai
            <br />
            for the first year.
          </h1>
        </header>

        <section className="space-y-6 text-lg leading-relaxed text-ink-soft">
          <p>
            you connect your email, your calendar, your photos. mira watches quietly. it reads
            the pediatric office, the daycare waitlist, the diaper subscription, the
            grandparent's question about what age was first solids.
          </p>
          <p>
            for the first week it just listens. then it begins drafting replies, scheduling
            checkups, filling forms — always asking before it acts, until you trust it not to.
          </p>
          <p>
            every morning you get one short digest of what's been handled and what still needs
            you. nothing else.
          </p>
        </section>

        <hr className="hairline" />

        <section className="space-y-4">
          <h2 className="font-serif text-2xl">what mira does today</h2>
          <ul className="space-y-3 text-ink-soft">
            <li>confirms pediatric appointments and fills pre-visit forms.</li>
            <li>reorders diapers, formula, and wipes from your usual sources.</li>
            <li>files parental leave paperwork — ei, provincial top-ups, employer hr.</li>
            <li>drafts replies to teachers, clinics, daycares in your voice.</li>
            <li>answers your questions about sleep, feeding, milestones, grounded in
              health canada guidelines and named frameworks (karp, ferber, markham).</li>
          </ul>
        </section>

        <hr className="hairline" />

        <section className="space-y-6">
          <h2 className="font-serif text-2xl">join the early cohort</h2>
          <p className="text-ink-soft">
            we're inviting ten toronto families in the first quarter. you get the product
            free for the first year in exchange for honest feedback.
          </p>
          <Link
            href="/sign-up"
            className="inline-flex items-center border border-ink bg-ink px-6 py-3 text-paper transition-colors hover:bg-ink-soft"
          >
            <span className="smallcaps">request an invite</span>
          </Link>
        </section>

        <footer className="pt-16 text-sm text-ink-quiet">
          <p className="smallcaps">mira · toronto · pipeda + law 25 compliant</p>
        </footer>
      </div>
    </main>
  );
}
