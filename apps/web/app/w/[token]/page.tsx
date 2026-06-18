import type { Metadata } from 'next';
import { db } from '~/lib/db';
import { type PublicWeekPlan, loadSharedWeekPlan } from '~/lib/village/public';

interface PageProps {
  params: Promise<{ token: string }>;
}

const CTA_URL = 'https://villagehale.com';

/**
 * Loads the shared plan for a token, or null. Public + unauthenticated: with no
 * DATABASE_URL (e.g. a static preview build) there is nothing to resolve, so we
 * return null and render the friendly not-found state rather than throwing.
 */
async function load(token: string): Promise<PublicWeekPlan | null> {
  if (!process.env.DATABASE_URL) {
    return null;
  }
  return loadSharedWeekPlan(token, db());
}

export const metadata: Metadata = {
  title: 'this week with Hale · the village your family lost',
  description: 'A handful of genuinely good local things to do this week, gathered by Hale.',
};

export default async function SharedWeekPage({ params }: PageProps) {
  const { token } = await params;
  const plan = await load(token);

  if (!plan) {
    return (
      <main className="min-h-screen bg-spruce text-on-spruce flex items-center justify-center px-6 py-24">
        <div className="max-w-xl text-center space-y-6">
          <p className="eyebrow text-on-spruce-soft">Hale</p>
          <h1 className="font-display text-[2rem] lg:text-[2.75rem] text-on-spruce">
            this week's plan isn't here anymore.
          </h1>
          <p className="text-lg text-on-spruce-soft leading-relaxed">
            The link may have expired or been mistyped. You can still start your own family's
            village.
          </p>
          <a
            href={CTA_URL}
            className="btn-primary mt-2"
            style={{ background: 'var(--color-linen)', color: 'var(--color-spruce)' }}
          >
            start your family's village →
          </a>
        </div>
      </main>
    );
  }

  const count = plan.activities.length;

  return (
    <main className="min-h-screen bg-linen text-spruce">
      <div className="shell py-16 lg:py-24 max-w-4xl">
        {/* ── Header ────────────────────────────────────────────────────── */}
        <header className="mb-14 lg:mb-20">
          <p className="eyebrow text-apricot-deep">shared with you · by Hale</p>
          <h1 className="font-display text-[2.25rem] lg:text-[3.25rem] leading-tight mt-3">
            {count} {count === 1 ? 'idea' : 'ideas'} for{' '}
            <span className="text-apricot-deep">families</span> this week.
          </h1>
          {plan.areaCoarse ? (
            <p className="meta mt-4 text-slate-green">around {plan.areaCoarse}</p>
          ) : null}
        </header>

        {/* ── Activity cards ────────────────────────────────────────────── */}
        {count === 0 ? (
          <section className="panel-oat px-6 py-12 text-center">
            <p className="font-display text-[1.5rem] text-spruce">a quiet week here.</p>
            <p className="meta mt-3 text-slate-green">nothing gathered to share just yet.</p>
          </section>
        ) : (
          <section className="space-y-0">
            {plan.activities.map((activity, idx) => (
              <article
                key={`${activity.kind}-${idx}`}
                className="py-10 lg:py-12 border-t border-rule first:border-t-0"
              >
                <p className="eyebrow text-spruce">{activity.kind}</p>
                <h2 className="font-display text-[1.5rem] lg:text-[2rem] leading-tight mt-2">
                  {activity.title}
                </h2>
                <p className="text-lg text-spruce leading-relaxed mt-4">{activity.summary}</p>
                {activity.coverageNote ? (
                  <p className="meta mt-3 text-slate-green">{activity.coverageNote}</p>
                ) : null}
                {activity.sourceUrl ? (
                  <a
                    href={activity.sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="btn-ghost mt-4"
                  >
                    see the listing →
                  </a>
                ) : null}
              </article>
            ))}
          </section>
        )}

        {/* ── Acquisition CTA ───────────────────────────────────────────── */}
        <section className="mt-16 lg:mt-24 panel px-6 py-10 lg:px-10 lg:py-12 text-center space-y-5">
          <h2 className="font-display text-[1.75rem] lg:text-[2.25rem] leading-tight">
            the village your family lost — rebuilt.
          </h2>
          <p className="text-lg text-slate-green leading-relaxed max-w-2xl mx-auto">
            Hale finds the genuinely good local things to do, matched to your child, across every
            stage of childhood. Your family's data stays in Canada.
          </p>
          <a href={CTA_URL} className="btn-primary">
            start your family's village →
          </a>
        </section>

        {/* ── Colophon ──────────────────────────────────────────────────── */}
        <footer className="mt-12 flex flex-wrap items-baseline justify-between gap-y-2 text-faded-sage">
          <p className="meta">only a coarse area is ever shared · never a precise location</p>
          <p className="meta">gathered by Hale · villagehale.com</p>
        </footer>
      </div>
    </main>
  );
}
