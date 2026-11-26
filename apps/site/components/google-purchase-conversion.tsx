'use client';

import { useEffect } from 'react';
import { installGoogleAds } from '~/lib/analytics/google-ads-client';
import {
  type GooglePurchaseEvent,
  fireGooglePurchaseConversion,
} from '~/lib/analytics/google-purchase';
import { CONSENT_EVENT, readConsent } from '~/lib/site/consent';

/**
 * Fires the Google Ads Website Purchase only when readConsent() is granted: a stored
 * Accept, or a default-on region with no stored refusal and no Global Privacy Control.
 * Turn off or No thanks sends nothing. A grant that arrives after the first effect
 * still sends the Purchase. Reloads are a no-op: sessionStorage is keyed by the
 * Stripe Checkout Session id.
 */
export function GooglePurchaseConversion(event: GooglePurchaseEvent): null {
  const { sendTo, value, currency, transactionId } = event;
  useEffect(() => {
    function send() {
      if (readConsent() !== 'granted') return;
      installGoogleAds();
      const gtag = (window as Window & { gtag?: (...args: unknown[]) => void }).gtag;
      fireGooglePurchaseConversion(
        { sendTo, value, currency, transactionId },
        gtag,
        sessionStorage,
      );
    }
    send();
    function onConsent(consentEvent: Event) {
      if ((consentEvent as CustomEvent<string>).detail !== 'granted') return;
      send();
    }
    window.addEventListener(CONSENT_EVENT, onConsent);
    return () => window.removeEventListener(CONSENT_EVENT, onConsent);
  }, [sendTo, value, currency, transactionId]);
  return null;
}
