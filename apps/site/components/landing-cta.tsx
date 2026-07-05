'use client';

import type { AnalyticsEvent } from '~/lib/analytics/events';
import { useAnalytics } from '~/lib/analytics/posthog-provider';

/**
 * A landing CTA anchor that captures its click (funnel top-of-loop) before the
 * navigation proceeds. Coarse by construction — the event name carries no
 * properties, so no PII can leave the page (hard rule #1). Used for the hero's
 * "See what Hale finds for you" → preview and "Join the village" → sign-up.
 */
export function LandingCta({
  event,
  href,
  className,
  children,
}: {
  event: AnalyticsEvent;
  href: string;
  className?: string;
  children: React.ReactNode;
}) {
  const capture = useAnalytics();
  return (
    <a href={href} className={className} onClick={() => capture(event)}>
      {children}
    </a>
  );
}
