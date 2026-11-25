'use client';

import { useEffect } from 'react';
import {
  attributionCookie,
  clearAttributionCookie,
  readFirstTouchAttribution,
} from '~/lib/analytics/attribution';
import { funnelAttributionForCookie } from '~/lib/analytics/funnel-views';
import { readFirstTouchSourceCode } from '~/lib/analytics/source-code';
import { CONSENT_EVENT, readConsent } from '~/lib/site/consent';

/**
 * Persists first-touch UTMs / gclid / fbclid into sessionStorage (every visit)
 * and a first-party cookie after Accept, so checkout on the app subdomain can
 * read them. No parent-facing copy.
 */
export function AttributionCapture(): null {
  useEffect(() => {
    const persist = () => {
      let storage: Storage | null = null;
      try {
        storage = window.sessionStorage;
      } catch {
        storage = null;
      }
      const attribution = readFirstTouchAttribution(window.location.search, storage);
      if (readConsent() !== 'granted') {
        // Withdrawing Accept must remove the cookie checkout would still read.
        document.cookie = clearAttributionCookie(window.location.hostname);
        return;
      }
      const withCode = funnelAttributionForCookie(attribution, () =>
        readFirstTouchSourceCode(window.location.search, storage),
      );
      const cookie = attributionCookie(withCode, window.location.hostname);
      if (cookie) document.cookie = cookie;
    };
    persist();
    window.addEventListener(CONSENT_EVENT, persist);
    return () => window.removeEventListener(CONSENT_EVENT, persist);
  }, []);
  return null;
}
