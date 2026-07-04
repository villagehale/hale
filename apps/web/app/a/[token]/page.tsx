import type { Metadata } from 'next';
import {
  JOIN_HREF,
  JoinCta,
  PublicActivityCard,
  PublicColophon,
  PublicHero,
} from '~/components/hale/public-surface';
import { db } from '~/lib/db';
import { type PublicActivityCard as PublicActivityCardData, loadSharedActivity } from '~/lib/village/public-activity';
import { activityShareMeta } from '~/lib/village/share-meta';

interface PageProps {
  params: Promise<{ token: string }>;
}

/** Public + unauthenticated. No DATABASE_URL (static preview) → null → friendly
 * not-found state. A child-attributed candidate also resolves null (fail closed,
 * rule #1). */
async function load(token: string): Promise<PublicActivityCardData | null> {
  if (!process.env.DATABASE_URL) {
    return null;
  }
  return loadSharedActivity(token, db());
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { token } = await params;
  return activityShareMeta(await load(token));
}

export default async function SharedActivityPage({ params }: PageProps) {
  const { token } = await params;
  const card = await load(token);

  if (!card) {
    return (
      <main className="min-h-screen bg-spruce text-on-spruce flex items-center justify-center px-6 py-24">
        <div className="max-w-xl text-center space-y-6">
          <p className="eyebrow text-on-spruce-soft">Hale</p>
          <h1 className="font-display text-[2rem] lg:text-[2.75rem] text-on-spruce">
            this pick isn't here anymore.
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

  return (
    <main className="min-h-screen bg-linen text-spruce">
      <div className="shell py-12 lg:py-16 max-w-3xl space-y-12 lg:space-y-16">
        <PublicHero
          eyebrow="a local pick · shared by Hale"
          headline={
            <>
              one good thing for{' '}
              <span className="text-apricot-deep">families</span> near you.
            </>
          }
          area={card.areaCoarse}
        />

        <section>
          <PublicActivityCard activity={card.activity} area={card.areaCoarse} />
        </section>

        <JoinCta heading="there's more where this came from." />

        <PublicColophon />
      </div>
    </main>
  );
}
