'use client';

import { ChevronLeft } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { type RootHero, type RootRoute, resolveHero } from '~/components/hale/hero-map';
import { Icon } from '~/components/ui/icon';

/**
 * The single page hero (design handoff §3.2). A tab root renders a serif <h1> hero
 * title + subtitle; a drilled-in page renders a breadcrumb eyebrow + back button +
 * drill title. Both the desktop top bar and the narrow-viewport stage read this same
 * component (resolving off the pathname against the server-built root heroes), so the
 * two frames can never disagree — and no page renders its own duplicate header.
 *
 * `variant` only tunes spacing: `topbar` sits inside the desktop top bar's hero slot,
 * `stage` is the mobile block at the top of the scrolling stage.
 */
export function PageHero({
  roots,
  variant,
}: {
  roots: Record<RootRoute, RootHero>;
  variant: 'topbar' | 'stage';
}) {
  const pathname = usePathname();
  const resolved = resolveHero(pathname, roots);
  if (!resolved) return null;

  if (resolved.kind === 'drill') {
    const { crumb, title, backHref } = resolved.hero;
    return (
      <div className={`page-hero page-hero-${variant}`}>
        <Link href={backHref} className="page-hero-back" aria-label={`Back to ${crumb}`}>
          <Icon as={ChevronLeft} size={18} />
          <span className="page-hero-crumb">{crumb}</span>
        </Link>
        <h1 className="page-hero-title page-hero-title-drill font-display font-semibold">
          {title}
        </h1>
      </div>
    );
  }

  const { title, subtitle, emoji } = resolved.hero;
  return (
    <div className={`page-hero page-hero-${variant}`}>
      <h1 className="page-hero-title font-display" data-hale-pii>
        {title}
        {emoji ? (
          <>
            {' '}
            <span aria-hidden>{emoji}</span>
          </>
        ) : null}
      </h1>
      <p className="page-hero-sub">{subtitle}</p>
    </div>
  );
}
