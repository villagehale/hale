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
 *
 * The `data-cta` pair is the wiring made VISIBLE in the markup. An `onClick` leaves no
 * trace in rendered HTML, so a plain `<a href={cta.href}>` beside a wired one is
 * indistinguishable — which is how seven `sms:` CTAs shipped uncounted. These
 * attributes are what the site-wide guard reads (app/cta-wiring.test.ts), so a new
 * unwired composer link is a red test rather than a hole in the funnel.
 */
export function LandingCta({
  event,
  placement,
  href,
  className,
  children,
}: {
  event: AnalyticsEvent;
  /** Which CTA this is — `hero`, `header`, `faq`… Omitted where the event
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
      data-cta={event}
      data-cta-placement={placement}
      onClick={() => capture(event, placement ? { cta_placement: placement } : {})}
    >
      {children}
    </a>
  );
}
