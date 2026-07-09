import { Lock, Star } from 'lucide-react';
import { AcceptButton } from '~/components/hale/accept-button';
import { EndorseButton } from '~/components/hale/endorse-button';
import { RegisterLink } from '~/components/hale/register-link';
import { SaveButton } from '~/components/hale/save-button';
import { ShareButton } from '~/components/hale/share-button';
import { SocialProofBadge } from '~/components/hale/public-surface';
import { Icon } from '~/components/ui/icon';
import { DEFAULT_TIMEZONE, foundStamp } from '~/lib/format/datetime';
import { indoorOutdoorLabel, priceBandLabel, villageKindLabel } from '~/lib/format/labels';
import type { VillageCandidateView } from '~/lib/village/mappers';

/**
 * The ONE village activity card. The feed (home), the search list, and the map
 * pop-up are the same contract in three shapes, so social proof, the trusted
 * controls, and the teen-locked treatment can never drift between surfaces:
 *
 *   - `card`  — the home feed's warm, raised, image-forward article.
 *   - `row`   — the /village search list's editorial row.
 *   - `panel` — the map pop-up over a tapped marker.
 *
 * Every non-locked variant carries the SAME cluster: the aggregate SocialProofBadge
 * (the single social-proof surface — the EndorseButton no longer repeats the count,
 * so "loved by N families near you" renders once), then Accept / Register / Endorse
 * / Share. Categories run through `villageKindLabel` — a stored token never renders
 * raw (rule #1).
 *
 * Teen safety (rule #1): a teen-attributed candidate arrives redacted to
 * category-only (title is the placeholder, summary empty) and renders the locked
 * treatment — no endorse/share/accept on content a parent can't preview.
 */

export type ActivityCardVariant = 'card' | 'row' | 'panel';

interface ActivityCardProps {
  candidate: VillageCandidateView;
  variant: ActivityCardVariant;
  area?: string | null;
  /** Rise-animation delay class on the `card`/`row` variants; the panel is static. */
  className?: string;
  /** The map panel's dismiss control — only rendered on `variant="panel"`. */
  onClose?: () => void;
}

export function ActivityCard({
  candidate,
  variant,
  area = null,
  className = '',
  onClose,
}: ActivityCardProps) {
  const kindLabel = villageKindLabel(candidate.kind);

  if (candidate.teenAttributed) {
    return <TeenLocked candidate={candidate} variant={variant} kindLabel={kindLabel} className={className} />;
  }

  const proof = <SocialProofBadge count={candidate.endorsementCount} />;
  const actions = <ActivityActions candidate={candidate} area={area} />;

  if (variant === 'row') {
    return (
      <article className={`${className} py-12 lg:py-14 border-t border-rule first:border-t-0`}>
        <div className="grid grid-cols-1 md:grid-cols-12 gap-y-6 md:gap-x-8">
          <div className="md:col-span-2">
            {kindLabel ? <p className="eyebrow text-spruce">{kindLabel}</p> : null}
          </div>
          <div className="md:col-span-7 space-y-5">
            <h2 className="font-display text-[1.75rem] lg:text-[2.25rem] leading-tight">
              {candidate.title}
            </h2>
            {candidate.summary ? (
              <p className="text-lg text-spruce leading-relaxed">{candidate.summary}</p>
            ) : null}
            {candidate.coverageNote ? (
              <p className="meta text-slate-green">{candidate.coverageNote}</p>
            ) : null}
            {proof}
            {actions}
          </div>
        </div>
      </article>
    );
  }

  if (variant === 'panel') {
    return (
      <section className="panel bg-raised flex flex-col gap-4">
        <div className="flex items-baseline justify-between gap-4">
          <p className="eyebrow text-spruce">{kindLabel ?? ''}</p>
          {onClose ? (
            <button type="button" className="btn-ghost" onClick={onClose} aria-label="close activity">
              close
            </button>
          ) : null}
        </div>
        <h3 className="font-display text-[1.5rem] lg:text-[1.875rem] leading-tight text-spruce">
          {candidate.title}
        </h3>
        {candidate.venueName ? (
          <p className="meta text-slate-green">{candidate.venueName}</p>
        ) : null}
        {candidate.summary ? (
          <p className="text-lg text-spruce leading-relaxed">{candidate.summary}</p>
        ) : null}
        <MetaChips candidate={candidate} />
        {proof}
        {actions}
      </section>
    );
  }

  return (
    <article className={`${className} panel bg-raised flex flex-col gap-4`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {kindLabel ? <p className="eyebrow text-spruce">{kindLabel}</p> : null}
        <CadenceChip cadence={candidate.cadence} />
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
      <MetaChips candidate={candidate} />
      <p className="meta text-faded-sage">{foundStamp(candidate.discoveredAt, DEFAULT_TIMEZONE)}</p>
      {proof}
      {actions}
    </article>
  );
}

/** The shared action cluster every non-locked variant carries — Accept / Register,
 * then Save ("I'm interested") / Endorse / Share pushed to the trailing edge on
 * wider viewports. */
function ActivityActions({
  candidate,
  area,
}: {
  candidate: VillageCandidateView;
  area: string | null;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-4 pt-1">
      <AcceptButton href={candidate.acceptHref} initiallyAccepted={candidate.accepted} />
      <RegisterLink sourceUrl={candidate.sourceUrl} title={candidate.title} area={area} />
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3 sm:ml-auto">
        <SaveButton endpoint={candidate.saveHref} initiallySaved={candidate.saved} />
        <EndorseButton
          endpoint={candidate.endorseHref}
          initiallyEndorsed={candidate.endorsedByFamily}
        />
        <ShareButton
          endpoint={candidate.shareHref}
          label="share this pick"
          shareTitle={candidate.title}
          variant="ghost"
        />
      </div>
    </div>
  );
}

/** The locked treatment for a teen-attributed candidate — category only, no raw
 * text, no actions. Shaped per variant so it sits correctly in each layout. */
function TeenLocked({
  candidate,
  variant,
  kindLabel,
  className,
}: {
  candidate: VillageCandidateView;
  variant: ActivityCardVariant;
  kindLabel: string | null;
  className: string;
}) {
  if (variant === 'row') {
    return (
      <article className={`${className} py-12 lg:py-14 border-t border-rule first:border-t-0`}>
        <div className="grid grid-cols-1 md:grid-cols-12 gap-y-6 md:gap-x-8">
          <div className="md:col-span-2">
            {kindLabel ? <p className="eyebrow text-spruce">{kindLabel}</p> : null}
          </div>
          <div className="md:col-span-7">
            <p className="flex items-center gap-2 text-spruce leading-relaxed">
              <Icon as={Lock} size={18} className="shrink-0 text-slate-green" />
              {candidate.title}
            </p>
          </div>
        </div>
      </article>
    );
  }

  return (
    <article className={`${className} panel bg-raised flex items-center gap-3`}>
      <Icon as={Lock} size={18} className="shrink-0 text-slate-green" />
      <div>
        {kindLabel ? <p className="eyebrow text-spruce">{kindLabel}</p> : null}
        <p className="meta mt-1 text-slate-green">{candidate.title}</p>
      </div>
    </article>
  );
}

/** The three recognised cadences → their static-pill treatment. Tone by LABEL +
 * shape (a colour tint, never colour alone — the text carries the meaning), no
 * emoji. `seasonal` reads as time-boxed (apricot), `one-time` as a single event
 * (sky), `ongoing` as a standing option (the base oat pill). */
const CADENCE_PILL: Record<string, { label: string; className: string }> = {
  seasonal: { label: 'seasonal', className: 'pill pill-apricot' },
  'one-time': { label: 'one-time', className: 'pill pill-sky' },
  ongoing: { label: 'ongoing', className: 'pill' },
};

/** A static cadence label on a card. Null cadence (pre-cadence rows, unclassified
 * candidates, teen-redacted cards) or an unrecognised value renders nothing. */
function CadenceChip({ cadence }: { cadence: string | null }) {
  const pill = cadence ? CADENCE_PILL[cadence] : undefined;
  if (!pill) return null;
  return <span className={pill.className}>{pill.label}</span>;
}

/**
 * The honest, presence-gated metadata row: a VERIFIED Places rating (a real number
 * with a count, never fabricated stars), then the model's coarse price band, age
 * hint, and indoor/outdoor tag — each rendered as a small pill ONLY when a real
 * value is present. Renders nothing at all when every field is null (a candidate
 * with no metadata shows no empty row). Teen-redacted cards arrive with every field
 * nulled at the mapper, so this never surfaces on them (rule #1).
 */
function MetaChips({ candidate }: { candidate: VillageCandidateView }) {
  const price = priceBandLabel(candidate.priceLevel);
  const place = indoorOutdoorLabel(candidate.indoorOutdoor);
  const hasRating = candidate.rating !== null;
  if (!hasRating && !price && !candidate.ageRange && !place) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-2">
      {hasRating ? (
        <span className="pill inline-flex items-center gap-1.5">
          <Icon as={Star} size={14} className="text-apricot-deep" />
          {candidate.rating}
          {candidate.ratingCount !== null ? (
            <span className="text-slate-green">({candidate.ratingCount})</span>
          ) : null}
        </span>
      ) : null}
      {price ? <span className="pill">{price}</span> : null}
      {candidate.ageRange ? <span className="pill">{candidate.ageRange}</span> : null}
      {place ? <span className="pill">{place}</span> : null}
    </div>
  );
}
