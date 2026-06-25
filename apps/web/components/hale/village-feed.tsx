import { Lock, Sparkles } from 'lucide-react';
import { AcceptButton } from '~/components/hale/accept-button';
import { EndorseButton } from '~/components/hale/endorse-button';
import { Folio } from '~/components/hale/folio';
import { RegisterLink } from '~/components/hale/register-link';
import { ShareButton } from '~/components/hale/share-button';
import { SocialProofBadge } from '~/components/hale/public-surface';
import { Icon } from '~/components/ui/icon';
import type { VillageCandidateView } from '~/lib/village/mappers';

/**
 * The agent-ranked, trusted village feed — the home/primary surface. This is the
 * moat made the centerpiece: the cards arrive already ORDERED by the
 * rank-recommendations agent (fit + trust + memory), so the feed reads as "what
 * your village, and families like yours, recommend near you."
 *
 * It is image-forward and social-proof-rich — the warm, raised-card treatment of
 * the public share surfaces (SocialProofBadge for "loved by N families near you"),
 * deliberately distinct from the quiet, utility Companion. Each card is endorsable
 * (EndorseButton — the trusted-parent half of hybrid trust) and shareable
 * (ShareButton — the viral leg), reusing the shipped controls so the private feed
 * and the public artifacts agree.
 *
 * Teen safety (rule #1): a teen-attributed candidate arrives already redacted to
 * category-only (title is the placeholder, summary empty) and renders the locked
 * treatment — no endorse/share/accept on content a parent can't preview.
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
        <VillageFeedCard
          key={candidate.id}
          candidate={candidate}
          index={idx + 1}
          delay={`rise-${Math.min(idx + 2, 7)}`}
          area={area}
        />
      ))}
    </section>
  );
}

function VillageFeedCard({
  candidate,
  index,
  delay,
  area,
}: {
  candidate: VillageCandidateView;
  index: number;
  delay: string;
  area: string | null;
}) {
  if (candidate.teenAttributed) {
    return (
      <article className={`rise ${delay} panel bg-raised flex items-center gap-3`}>
        <Icon as={Lock} size={18} className="shrink-0 text-slate-green" />
        <div>
          <p className="eyebrow text-spruce">{candidate.kind}</p>
          <p className="meta mt-1 text-slate-green">{candidate.title}</p>
        </div>
      </article>
    );
  }

  return (
    <article className={`rise ${delay} panel bg-raised flex flex-col gap-4`}>
      <div className="flex items-baseline justify-between gap-4">
        <p className="eyebrow text-spruce">{candidate.kind}</p>
        <Folio index={index} />
      </div>

      <h3 className="font-display text-[1.5rem] lg:text-[1.875rem] leading-tight text-spruce">
        {candidate.title}
      </h3>
      {candidate.summary ? (
        <p className="text-lg text-spruce leading-relaxed">{candidate.summary}</p>
      ) : null}
      {candidate.coverageNote ? (
        <p className="meta text-slate-green">{candidate.coverageNote}</p>
      ) : null}

      <SocialProofBadge count={candidate.endorsementCount} />

      <div className="flex flex-wrap items-center gap-x-6 gap-y-4 pt-1">
        <AcceptButton href={candidate.acceptHref} />
        <RegisterLink sourceUrl={candidate.sourceUrl} title={candidate.title} area={area} />
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3 sm:ml-auto">
          <EndorseButton
            endpoint={candidate.endorseHref}
            initiallyEndorsed={candidate.endorsedByFamily}
            initialCount={candidate.endorsementCount}
          />
          <ShareButton
            endpoint={candidate.shareHref}
            label="share this pick"
            shareTitle={candidate.title}
            variant="ghost"
          />
        </div>
      </div>
    </article>
  );
}

/** The feed's section header — names the trust ("your village + families like
 * yours") so the order reads as curated, not a generic list. */
export function VillageFeedHeader({ area }: { area?: string | null }) {
  return (
    <div className="flex items-center gap-3 border-b border-rule pb-4 mb-6">
      <Icon as={Sparkles} size={20} className="text-apricot-deep" />
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
