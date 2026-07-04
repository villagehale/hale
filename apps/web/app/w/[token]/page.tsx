import type { Metadata } from 'next';
import {
  JOIN_HREF,
  JoinCta,
  PublicActivityCard,
  PublicColophon,
  PublicHero,
} from '~/components/hale/public-surface';
import { db } from '~/lib/db';
import { type PublicWeekPlan, loadSharedWeekPlan } from '~/lib/village/public';
import { weekShareMeta } from '~/lib/village/share-meta';

interface PageProps {
  params: Promise<{ token: string }>;
}

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

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { token } = await params;
  return weekShareMeta(await load(token));
}

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
            href={JOIN_HREF}
            className="btn-primary mt-2"
            style={{ background: 'var(--color-linen)', color: 'var(--color-spruce)' }}
          >
            start your family's village &rarr;
          </a>
        </div>
      </main>
    );
  }

  const count = plan.activities.length;

  return (
    <main className="min-h-screen bg-linen text-spruce">
      <div className="shell py-12 lg:py-16 max-w-4xl space-y-12 lg:space-y-16">
        <PublicHero
          eyebrow="shared with you · by Hale"
          headline={
            <>
              {count} {count === 1 ? 'idea' : 'ideas'} for{' '}
              <span className="text-apricot-deep">families</span> this week.
            </>
          }
          area={plan.areaCoarse}
        />

        {count === 0 ? (
          <section className="panel-oat px-6 py-12 text-center">
            <p className="font-display text-[1.5rem] text-spruce">a quiet week here.</p>
            <p className="meta mt-3 text-slate-green">nothing gathered to share just yet.</p>
          </section>
        ) : (
          <section className="grid grid-cols-1 md:grid-cols-2 gap-5 lg:gap-6">
            {plan.activities.map((activity, idx) => (
              <PublicActivityCard
                key={`${activity.kind}-${idx}`}
                activity={activity}
                index={idx + 1}
                area={plan.areaCoarse}
              />
            ))}
          </section>
        )}

        <JoinCta heading="the village your family lost — rebuilt." />

        <PublicColophon />
      </div>
    </main>
  );
}
