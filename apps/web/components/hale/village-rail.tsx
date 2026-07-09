import { CalendarDays, Compass, MessageCircle } from 'lucide-react';
import Link from 'next/link';
import { Card } from '~/components/ui/card';
import { Icon } from '~/components/ui/icon';
import { formatCalendarDate } from '~/lib/format/datetime';
import { villageKindLabel } from '~/lib/format/labels';
import type { VillageCandidateView } from '~/lib/village/mappers';
import { upcomingDatedCandidates } from '~/lib/village/upcoming';

/**
 * The village board's right rail — three quiet, warm-white cards that sit beside
 * the near-you list on the desktop board and stack below it on mobile. Every card
 * is server-rendered from a REAL loader and states an honest empty case rather than
 * a placeholder (rule #8). No tinted backgrounds — the plain `.card` surface is
 * differentiated by eyebrow labels and the orange accent, not colour washes.
 *
 * Teen safety (rule #1): the views arrive already teen-redacted from the mapper, so
 * a dated teen event (eventDate nulled) never reaches Upcoming and a teen-attributed
 * pick never surfaces its content here.
 */
export function VillageRail({
  candidates,
  saved,
}: {
  /** The agent-ranked feed views (feed.candidates), in ranked order. */
  candidates: VillageCandidateView[];
  /** The family's privately-saved views (loadSavedVillageCandidates). */
  saved: VillageCandidateView[];
}) {
  const upcoming = upcomingDatedCandidates(candidates).slice(0, 4);
  const pick = candidates[0] ?? null;
  const savedPreview = saved.slice(0, 3);

  return (
    <aside className="space-y-5">
      <UpcomingCard events={upcoming} />
      <SavedCard saved={savedPreview} total={saved.length} />
      <FromHaleCard pick={pick} />
    </aside>
  );
}

function RailHeader({ icon, children }: { icon: typeof CalendarDays; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 mb-4">
      <Icon as={icon} size={16} className="text-apricot-deep" />
      <span className="eyebrow text-apricot-deep">{children}</span>
    </div>
  );
}

/** Upcoming — dated events soonest-first, small dated rows. Honest empty state when
 * the family has no dated rows yet (the common case until a discovery run produces
 * one). */
function UpcomingCard({
  events,
}: {
  events: Array<VillageCandidateView & { eventDate: string }>;
}) {
  return (
    <Card className="rise rise-3">
      <RailHeader icon={CalendarDays}>upcoming</RailHeader>
      {events.length === 0 ? (
        <p className="meta text-slate-green">no dated events yet — Hale surfaces them here as it finds them.</p>
      ) : (
        <ul className="space-y-3">
          {events.map((event) => {
            const kindLabel = villageKindLabel(event.kind);
            return (
              <li key={event.id} className="flex items-baseline gap-3 border-t border-rule pt-3 first:border-t-0 first:pt-0">
                <span className="meta text-apricot-deep tabular shrink-0">
                  {formatCalendarDate(event.eventDate)}
                </span>
                <div className="min-w-0">
                  <p className="text-spruce leading-snug truncate">{event.title}</p>
                  {kindLabel ? <p className="meta text-faded-sage">{kindLabel}</p> : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

/** Saved — a few compact rows of the family's saved picks plus a "view all" into
 * /saved. Honest empty state when nothing is saved. */
function SavedCard({
  saved,
  total,
}: {
  saved: VillageCandidateView[];
  total: number;
}) {
  return (
    <Card className="rise rise-4">
      <RailHeader icon={Compass}>saved</RailHeader>
      {saved.length === 0 ? (
        <p className="meta text-slate-green">nothing saved yet — tap the bookmark on a pick to keep it here.</p>
      ) : (
        <>
          <ul className="space-y-3">
            {saved.map((candidate) => {
              const kindLabel = villageKindLabel(candidate.kind);
              return (
                <li key={candidate.id} className="border-t border-rule pt-3 first:border-t-0 first:pt-0">
                  <p className="text-spruce leading-snug truncate">{candidate.title}</p>
                  {kindLabel ? <p className="meta text-faded-sage">{kindLabel}</p> : null}
                </li>
              );
            })}
          </ul>
          <Link href="/saved" className="link mt-4 inline-block">
            view all {total} saved →
          </Link>
        </>
      )}
    </Card>
  );
}

/** From Hale — the agent's genuine #1 ranked pick (feed.candidates[0]), surfaced as
 * "Hale's pick near you", plus an ask-your-concierge entry into /coach. No stored
 * blurb exists, so nothing is fabricated — the pick's own title/category carry it. */
function FromHaleCard({ pick }: { pick: VillageCandidateView | null }) {
  const kindLabel = pick && !pick.teenAttributed ? villageKindLabel(pick.kind) : null;
  return (
    <Card className="rise rise-5">
      <RailHeader icon={MessageCircle}>from Hale</RailHeader>
      {pick && !pick.teenAttributed ? (
        <div className="mb-4">
          <p className="meta text-faded-sage">Hale&rsquo;s pick near you</p>
          <p className="text-spruce leading-snug mt-1">{pick.title}</p>
          {kindLabel ? <p className="meta text-faded-sage mt-0.5">{kindLabel}</p> : null}
        </div>
      ) : (
        <p className="meta text-slate-green mb-4">
          Hale hasn&rsquo;t ranked a pick for you yet — it will once your village fills in.
        </p>
      )}
      <Link href="/coach" className="link inline-flex items-center gap-2">
        <Icon as={MessageCircle} size={16} />
        ask your concierge
      </Link>
    </Card>
  );
}
