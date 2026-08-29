'use client';

import { useEffect, useRef } from 'react';
import { useAnalytics, useAnalyticsReady } from '~/lib/analytics/posthog-provider';
import { newlyCrossedDepths, scrolledFraction } from '~/lib/analytics/scroll-depth';

/**
 * How far down the landing a reader got. Renders nothing.
 *
 * The decision — which milestones this position newly crossed — is a pure function
 * (lib/analytics/scroll-depth.ts) so the once-per-depth-per-view rule is tested without
 * a browser; this component is only the wiring: a passive scroll listener, a Set of
 * what has already been reported, and one `landing_scroll` per new milestone.
 *
 * The Set lives in a ref rather than in state on purpose: a re-render must not reset it
 * (that would re-report 25% on every theme toggle), and crossing a milestone must not
 * re-render the landing.
 *
 * `page` is a coarse name for WHICH long page was scrolled (the city guides pass their
 * `guide.placement`). The homepage omits it — its historical `landing_scroll` rows have
 * no `page`, and absent must keep meaning "the landing" rather than becoming a string.
 */
export function LandingScrollAnalytics({ page }: { page?: string } = {}) {
  const capture = useAnalytics();
  const ready = useAnalyticsReady();
  const sent = useRef<Set<number>>(new Set());

  useEffect(() => {
    // Nothing is marked as reported before capture can actually send: the client
    // arrives on a dynamic import, and latching a depth against a no-op would lose the
    // above-the-fold milestone for the whole view.
    if (!ready) return;

    const onScroll = (): void => {
      const fraction = scrolledFraction({
        scrollY: window.scrollY,
        viewportHeight: window.innerHeight,
        documentHeight: document.documentElement.scrollHeight,
      });
      for (const depth of newlyCrossedDepths(fraction, sent.current)) {
        sent.current.add(depth);
        capture('landing_scroll', page ? { depth, page } : { depth });
      }
    };

    // Once up front: a short viewport, a deep link to an anchor, or a restored scroll
    // position all mean the reader has already passed a milestone before scrolling.
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [capture, ready, page]);

  return null;
}
