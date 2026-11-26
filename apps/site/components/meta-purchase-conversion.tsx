'use client';

import { useEffect } from 'react';
import { installMetaPixel } from '~/lib/analytics/meta-pixel-client';
import { type MetaPurchaseEvent, fireMetaPurchaseConversion } from '~/lib/analytics/meta-purchase';
import { CONSENT_EVENT, readConsent } from '~/lib/site/consent';

/**
 * Browser Purchase with eventID = Stripe Checkout Session id, so Meta
 * dedupes against the CAPI event. Reloads are a no-op. The pixel installs
 * only when readConsent() is granted: a stored Accept, or a default-on region
 * with no stored refusal and no Global Privacy Control. A grant that arrives
 * after the first effect still sends Purchase. A later dataset has no CAPI
 * event to fall back on.
 */
export function MetaPurchaseConversion(event: MetaPurchaseEvent): null {
  const { pixelId, value, currency, transactionId } = event;
  useEffect(() => {
    function send() {
      if (readConsent() === 'granted') installMetaPixel(pixelId);
      const fbq = (window as Window & { fbq?: (...args: unknown[]) => void }).fbq;
      fireMetaPurchaseConversion({ pixelId, value, currency, transactionId }, fbq, sessionStorage);
    }
    send();
    function onConsent(consentEvent: Event) {
      if ((consentEvent as CustomEvent<string>).detail !== 'granted') return;
      send();
    }
    window.addEventListener(CONSENT_EVENT, onConsent);
    return () => window.removeEventListener(CONSENT_EVENT, onConsent);
  }, [pixelId, value, currency, transactionId]);
  return null;
}
