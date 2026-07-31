import type { Metadata } from 'next';
import { PublicColophon } from '~/components/hale/public-surface';
import { db } from '~/lib/db';
import { type PartyCard, buildPartyCard } from '~/lib/party/card';
import { loadPublicParty } from '~/lib/party/store';
import { RsvpForm } from './rsvp-form';

/**
 * GET /rsvp/:token — VIL-245 · M10. The public, unauthenticated invite page: the one
 * Hale surface built for people who are not customers and will mostly never be.
 *
 * WHAT IT SHOWS is what the host typed and asked Hale to publish — the party's name,
 * when it is, and where. The address is on it deliberately: an invitation that withheld
 * the location would not be an invitation, and this is host-AUTHORIZED disclosure.
 *
 * WHAT IT NEVER SHOWS is anyone else. Not the guest list (that is other guests' data
 * and the host's alone), not the family, not a sibling, not a coarse area, not another
 * event. And never a 13+ child's name — {@link buildPartyCard} strips it at READ time,
 * on every render, from a title Hale deliberately does not trust from storage.
 *
 * `noindex`: a family's address and a child's party do not belong in a search index,
 * and a link nobody was given should stay a link nobody has.
 */

interface PageProps {
  params: Promise<{ token: string }>;
}

/** Public + unauthenticated. No DATABASE_URL (static preview) → null → not-found. */
async function load(token: string): Promise<PartyCard | null> {
  if (!process.env.DATABASE_URL) return null;
  const party = await loadPublicParty(db(), token);
  if (!party) return null;
  return buildPartyCard({
    title: party.title,
    location: party.location,
    startsAt: party.startsAt,
    timeZone: party.timeZone,
    cancelled: party.cancelled,
    teenFirstNames: party.teenFirstNames,
  });
}

/**
 * Deliberately generic. A share preview is rendered by whatever app the link was pasted
 * into, and the party's name, date and address must not be handed to a link-unfurling
 * service that nobody in this exchange chose.
 */
export const metadata: Metadata = {
  title: "You're invited · Hale",
  description: 'An invitation. Open it to RSVP.',
  robots: { index: false, follow: false },
};

export default async function RsvpPage({ params }: PageProps) {
  const { token } = await params;
  const card = await load(token);

  if (!card) {
    return (
      <main className="min-h-screen bg-spruce text-on-spruce flex items-center justify-center px-6 py-24">
        <div className="max-w-xl text-center space-y-6">
          <p className="eyebrow text-on-spruce-soft">Hale</p>
          <h1 className="font-display text-[2rem] lg:text-[2.75rem] text-on-spruce">
            this invite isn't here anymore.
          </h1>
          <p className="text-lg text-on-spruce-soft leading-relaxed">
            The link may have expired or been mistyped. Ask whoever sent it for a fresh one.
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-linen text-spruce">
      <div className="shell py-12 lg:py-16 max-w-2xl space-y-8 lg:space-y-12">
        <header className="panel-apricot-tint px-6 py-10 lg:px-10 lg:py-12 space-y-3">
          <p className="eyebrow text-slate-green">you're invited</p>
          <h1 className="font-display text-[2rem] lg:text-[2.75rem] leading-tight text-spruce text-balance">
            {card.title}
          </h1>
          <p className="text-lg text-slate-green leading-relaxed">{card.when}</p>
          {card.location ? (
            <p className="text-lg text-slate-green leading-relaxed">{card.location}</p>
          ) : null}
        </header>

        {card.cancelled ? (
          <section className="panel p-6 lg:p-8 space-y-2">
            <h2 className="font-display text-[1.5rem] text-spruce">This party was cancelled.</h2>
            <p className="text-slate-green leading-relaxed">
              The host called it off. No need to reply.
            </p>
          </section>
        ) : (
          <RsvpForm token={token} />
        )}

        <PublicColophon />
      </div>
    </main>
  );
}
