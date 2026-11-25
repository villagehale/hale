'use client';

import { useEffect } from 'react';
import { installGoogleAds } from '~/lib/analytics/google-ads-client';
import {
  fireGooglePurchaseConversion,
  type GooglePurchaseEvent,
} from '~/lib/analytics/google-purchase';
import { CONSENT_EVENT, readConsent } from '~/lib/site/consent';

/**
 * Fires the Google Ads Website Purchase once the marketing-site tag is loaded, and only
 * while the visitor has accepted: the privacy page says Google Ads measures a visit only
 * after Accept, so a tag left on the page after "No thanks" sends nothing. Accept on this
 * page arrives after the first effect, so the grant event sends the Purchase then.
 * Reloads are a no-op: sessionStorage is keyed by the Stripe Checkout Session id.
 */
export function GooglePurchaseConversion(event: GooglePurchaseEvent): null {
  const { sendTo, value, currency, transactionId } = event;
  useEffect(() => {
    function send() {
      if (readConsent() !== 'granted') return;
      installGoogleAds();
      const gtag = (window as Window & { gtag?: (...args: unknown[]) => void }).gtag;
      fireGooglePurchaseConversion({ sendTo, value, currency, transactionId }, gtag, sessionStorage);
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
