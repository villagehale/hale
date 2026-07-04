import { Compass } from 'lucide-react';
import { ActivityCard } from '~/components/hale/activity-card';
import { Icon } from '~/components/ui/icon';
import type { VillageCandidateView } from '~/lib/village/mappers';

/**
 * The agent-ranked, trusted village feed — the home/primary surface. This is the
 * moat made the centerpiece: the cards arrive already ORDERED by the
 * rank-recommendations agent (fit + trust + memory), so the feed reads as "what
 * your village, and families like yours, recommend near you."
 *
 * It is image-forward and social-proof-rich — the warm, raised-card treatment of
 * the public share surfaces, deliberately distinct from the quiet, utility
 * Companion. Each card is the shared ActivityCard (`card` variant), so the private
 * feed, the search list, and the map pop-up render one contract: same social
 * proof, same trusted controls, same teen-locked treatment (rule #1).
 */
export function VillageFeed({
  candidates,
  area = null,
}: {
  candidates: VillageCandidateView[];
  area?: string | null;
}) {
  return (
    <section className="space-y-5">
      {candidates.map((candidate, idx) => (
        <ActivityCard
          key={candidate.id}
          candidate={candidate}
          variant="card"
          area={area}
          className={`rise rise-${Math.min(idx + 2, 7)}`}
        />
      ))}
    </section>
  );
}

/** The feed's section header — names the trust ("your village + families like
 * yours") so the order reads as curated, not a generic list. */
export function VillageFeedHeader({ area }: { area?: string | null }) {
  return (
    <div className="flex items-center gap-3 border-b border-rule pb-4 mb-6">
      <Icon as={Compass} size={20} className="text-apricot-deep" />
      <div>
        <h2 className="font-display text-[1.5rem] lg:text-[1.875rem] leading-tight">
          what your village recommends
        </h2>
        <p className="meta mt-1 text-slate-green">
          {area ? `families like yours, near ${area}` : 'ranked for your family by Hale'}
        </p>
      </div>
    </div>
  );
}
