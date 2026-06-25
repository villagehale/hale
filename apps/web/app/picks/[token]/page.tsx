import type { Metadata } from 'next';
import {
  JOIN_HREF,
  JoinCta,
  PublicActivityCard,
  PublicColophon,
  PublicHero,
} from '~/components/hale/public-surface';
import { db } from '~/lib/db';
import { type PublicPicks, loadSharedPicks } from '~/lib/village/public-picks';

interface PageProps {
  params: Promise<{ token: string }>;
}

/** Public + unauthenticated. No DATABASE_URL (static preview) → null → the
 * friendly not-found state, never a throw (mirrors /w). */
async function load(token: string): Promise<PublicPicks | null> {
  if (!process.env.DATABASE_URL) {
    return null;
  }
  return loadSharedPicks(token, db());
}

export const metadata: Metadata = {
  title: "a family's village picks · Hale",
  description: 'The local things families near here actually love — endorsed picks, gathered by Hale.',
};

export default async function SharedPicksPage({ params }: PageProps) {
  const { token } = await params;
  const picks = await load(token);

  if (!picks) {
    return (
      <main className="min-h-screen bg-spruce text-on-spruce flex items-center justify-center px-6 py-24">
        <div className="max-w-xl text-center space-y-6">
          <p className="eyebrow text-on-spruce-soft">Hale</p>
          <h1 className="font-display text-[2rem] lg:text-[2.75rem] text-on-spruce">
            these picks aren't here anymore.
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

  const count = picks.activities.length;

  return (
    <main className="min-h-screen bg-linen text-spruce">
      <div className="shell py-12 lg:py-16 max-w-4xl space-y-12 lg:space-y-16">
        <PublicHero
          eyebrow="village picks · endorsed by a family near you"
          headline={
            <>
              {count} {count === 1 ? 'pick' : 'picks'} a family{' '}
              <span className="text-apricot-deep">actually loves</span>.
            </>
          }
          area={picks.areaCoarse}
        />

        {count === 0 ? (
          <section className="panel-oat px-6 py-12 text-center">
            <p className="font-display text-[1.5rem] text-spruce">no picks endorsed yet.</p>
            <p className="meta mt-3 text-slate-green">
              this family hasn't endorsed anything to share just yet.
            </p>
          </section>
        ) : (
          <section className="grid grid-cols-1 md:grid-cols-2 gap-5 lg:gap-6">
            {picks.activities.map((activity, idx) => (
              <PublicActivityCard
                key={`${activity.kind}-${idx}`}
                activity={activity}
                index={idx + 1}
                area={picks.areaCoarse}
              />
            ))}
          </section>
        )}

        <JoinCta heading="the picks come from real families — not an algorithm." />

        <PublicColophon />
      </div>
    </main>
  );
}
