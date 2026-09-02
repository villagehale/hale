'use client';

import { useEffect } from 'react';
import { useAnalytics } from '~/lib/analytics/posthog-provider';

/**
 * The /text entry view — the "conversations started" scoreboard's top of funnel
 * (VIL-240). Renders nothing.
 *
 * Attribution carries NO properties here: the card's `?s=` code used to be passed in
 * from the server page as `source`, which is now a second answer to a question the
 * provider already answers for every event on the site: `source_code`, first-touch,
 * resolved once (lib/analytics/source-code.ts). What the view DOES carry is the
 * chooser's own coarse facts, which no other event knows:
 *
 *   `device_hint`    — the server's Platform ordering hint (lib/chooser.ts). Named
 *                      device_hint, not platform_hint: buildEvent's forbidden-fragment
 *                      gate drops any key containing 'lat', and "platform" does.
 *   `channels_live`  — which pipes the page could offer: 'sms' | 'sms+whatsapp' |
 *                      'none' (the email-fallback state).
 *
 * `capture` is in the dependency list because its identity changes exactly once — when
 * the deferred PostHog client resolves — so the view lands on that pass rather than
 * being dropped by the no-op capture before it.
 */
export function TextEntryAnalytics({
  deviceHint,
  channelsLive,
}: {
  deviceHint: string;
  channelsLive: string;
}) {
  const capture = useAnalytics();

  useEffect(() => {
    capture('text_entry_viewed', { device_hint: deviceHint, channels_live: channelsLive });
  }, [capture, deviceHint, channelsLive]);

  return null;
}
