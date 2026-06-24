import { Heart } from 'lucide-react';
import { Cloud, Hill, SeaTurtle, Sun } from '~/components/illos';
import type { PublicActivity } from '~/lib/village/public';
import { endorsementLabel } from '~/lib/village/social-proof';

/**
 * The warmer, image-forward visual language for the PUBLIC share surfaces (the
 * week plan, picks, single activity). Distinct from the quiet-utility Companion
 * — livelier, illustration-led — while staying on-brand: Prussian/apricot
 * tokens, Inter, the focus ring, and the elevation ladder. These pages are
 * marketing that travels (rule of the brief), so they earn the warmth the authed
 * app deliberately withholds.
 *
 * Privacy (rule #1): every component here renders ONLY the public allow-list
 * (PublicActivity = title/kind/summary/sourceUrl/coverageNote + an aggregate
 * count) and a coarse area string. No child name, DOB, precise location, or
 * parent identity can reach these — they aren't in the props.
 */

/** The single join CTA target for every public artifact — the in-app entry
 * where a non-user signs up / joins the waitlist. One source of truth so the
 * conversion hook is identical (and testable) across all three surfaces. */
export const JOIN_HREF = '/sign-in';

/** The aggregate social-proof badge (a count, never a family identity). Renders
 * nothing below the threshold so a thin "loved by 1 family" never shows. */
export function SocialProofBadge({ count }: { count: number }) {
  const label = endorsementLabel(count);
  if (!label) {
    return null;
  }
  return (
    <span className="pill pill-apricot inline-flex items-center gap-1.5">
      <Heart size={14} strokeWidth={2.5} aria-hidden="true" />
      {label}
    </span>
  );
}

/**
 * The shared warm hero: a soft apricot-tint band with the sea turtle and a
 * couple of sky bodies behind the headline. Image-forward but calm — flat
 * shapes, no motion. The eyebrow/headline/area are passed by each artifact.
 */
export function PublicHero({
  eyebrow,
  headline,
  area,
}: {
  eyebrow: string;
  headline: React.ReactNode;
  area: string | null;
}) {
  return (
    <header className="relative overflow-hidden panel-apricot-tint px-6 py-12 lg:px-12 lg:py-16">
      <div className="pointer-events-none absolute inset-0 opacity-90" aria-hidden="true">
        <Sun className="absolute -right-4 -top-4 w-28 lg:w-36" />
        <Cloud className="absolute right-24 top-10 w-24 opacity-70 hidden sm:block" />
        <Hill className="absolute -bottom-2 -left-6 w-72 opacity-60" />
        <SeaTurtle age="adult" className="absolute bottom-2 right-6 w-32 lg:w-44" />
      </div>
      <div className="relative max-w-2xl">
        <p className="eyebrow text-apricot-deep">{eyebrow}</p>
        <h1 className="font-display text-[2.25rem] lg:text-[3.25rem] leading-tight mt-3 text-spruce text-balance">
          {headline}
        </h1>
        {area ? <p className="meta mt-4 text-slate-green">around {area}</p> : null}
      </div>
    </header>
  );
}

/**
 * One public activity card in the warm treatment — a raised card with the
 * category, title, summary, the aggregate social-proof badge, and the source
 * link. Used by every artifact so a card looks identical wherever it travels.
 */
export function PublicActivityCard({
  activity,
  index,
}: {
  activity: PublicActivity;
  index?: number;
}) {
  return (
    <article className="panel bg-raised flex flex-col gap-4">
      <div className="flex items-baseline justify-between gap-4">
        <p className="eyebrow text-spruce">{activity.kind}</p>
        {typeof index === 'number' ? (
          <span className="tabular text-sm text-faded-sage">
            {String(index).padStart(2, '0')}
          </span>
        ) : null}
      </div>
      <h2 className="font-display text-[1.5rem] lg:text-[1.875rem] leading-tight text-spruce">
        {activity.title}
      </h2>
      {activity.summary ? (
        <p className="text-lg text-spruce leading-relaxed">{activity.summary}</p>
      ) : null}
      {activity.coverageNote ? (
        <p className="meta text-slate-green">{activity.coverageNote}</p>
      ) : null}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3 pt-1">
        <SocialProofBadge count={activity.endorsementCount} />
        {activity.sourceUrl ? (
          <a href={activity.sourceUrl} target="_blank" rel="noreferrer" className="btn-ghost">
            see the listing &rarr;
          </a>
        ) : null}
      </div>
    </article>
  );
}

/**
 * The conversion hook every artifact ends with: a warm panel that turns a
 * non-user viewing the share into a join. The CTA links to JOIN_HREF (sign-up /
 * join the village).
 */
export function JoinCta({
  heading = 'see what families near you are doing.',
  sub = 'Hale finds the genuinely good local things to do, matched to your child, across every stage of childhood — and the families near you say which are worth it. Your family’s data stays in Canada.',
}: {
  heading?: string;
  sub?: string;
}) {
  return (
    <section className="panel-apricot-tint px-6 py-10 lg:px-12 lg:py-14 text-center space-y-5">
      <h2 className="font-display text-[1.75rem] lg:text-[2.5rem] leading-tight text-spruce text-balance">
        {heading}
      </h2>
      <p className="text-lg text-slate-green leading-relaxed max-w-2xl mx-auto">{sub}</p>
      <a href={JOIN_HREF} className="btn-primary">
        join the village &rarr;
      </a>
    </section>
  );
}

/** The shared footer/colophon stating the privacy posture plainly (DESIGN copy
 * rule + rule #1: privacy is felt). */
export function PublicColophon() {
  return (
    <footer className="flex flex-wrap items-baseline justify-between gap-y-2 text-faded-sage">
      <p className="meta">only a coarse area is ever shared · never a precise location</p>
      <p className="meta">gathered by Hale · villagehale.com</p>
    </footer>
  );
}
