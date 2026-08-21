'use client';

import { useEffect } from 'react';
import { useAnalytics } from '~/lib/analytics/posthog-provider';

/**
 * The /text entry view — the "conversations started" scoreboard's top of funnel
 * (VIL-240). Renders nothing.
 *
 * It carries NO properties of its own. The card's `?s=` code used to be passed in from
 * the server page as `source`, which is now a second answer to a question the provider
 * already answers for every event on the site: `source_code`, first-touch, resolved
 * once (lib/analytics/source-code.ts). Two codes on one row, able to disagree, is worse
 * than one — so this fires the view and the provider says where it came from.
 *
 * `capture` is in the dependency list because its identity changes exactly once — when
 * the deferred PostHog client resolves — so the view lands on that pass rather than
 * being dropped by the no-op capture before it.
 */
export function TextEntryAnalytics() {
  const capture = useAnalytics();

  useEffect(() => {
    capture('text_entry_viewed');
  }, [capture]);

  return null;
}
