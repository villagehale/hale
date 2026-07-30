'use client';

import { useEffect } from 'react';
import { useAnalytics } from '~/lib/analytics/posthog-provider';

/**
 * The /text entry view, attributed to the QR card that produced it — the
 * "conversations started" scoreboard's top of funnel (VIL-240). Renders nothing.
 *
 * The venue code is the only property, and it is a validated kebab code for a
 * place, never anything about the visitor (hard rule #1); `buildEvent` is the
 * backstop. `capture` is in the dependency list because its identity changes
 * exactly once — when the deferred PostHog client resolves — so the view lands
 * on that pass rather than being dropped by the no-op capture before it.
 */
export function TextEntryAnalytics({ source }: { source: string | null }) {
  const capture = useAnalytics();

  useEffect(() => {
    capture('text_entry_viewed', source ? { source } : {});
  }, [capture, source]);

  return null;
}
