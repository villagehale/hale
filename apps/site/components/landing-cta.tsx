'use client';

import type { AnalyticsEvent } from '~/lib/analytics/events';
import { useAnalytics } from '~/lib/analytics/posthog-provider';

/**
 * An outbound CTA anchor that captures its click before the navigation proceeds.
 *
 * Every `sms:` deep link on the site goes through this with `event="cta_text_click"`,
 * so "how many people opened a composer" is ONE number with a `cta_placement`
 * breakdown, rather than one event name per page (which is what the retired
 * `*_cta_text` trio was, and why no dashboard could read the funnel).
 *
 * Coarse by construction: `cta_placement` names a spot on a page and nothing else, and
 * `source_code`/`locale` are stamped by the provider, not passed here (hard rule #1).
 */
export function LandingCta({
  event,
  placement,
  href,
  className,
  children,
}: {
  event: AnalyticsEvent;
  /** Which CTA this is — `hero`, `header`, `faq`, `hero_chip`… Omitted where the event
   * only ever has one home (the contact card lives on /text alone). */
  placement?: string;
  href: string;
  className?: string;
  children: React.ReactNode;
}) {
  const capture = useAnalytics();
  return (
    <a
      href={href}
      className={className}
      onClick={() => capture(event, placement ? { cta_placement: placement } : {})}
    >
      {children}
    </a>
  );
}
