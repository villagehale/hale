'use client';

import { useEffect } from 'react';
import { installGoogleAds } from '~/lib/analytics/google-ads-client';
import {
  fireGooglePurchaseConversion,
  type GooglePurchaseEvent,
} from '~/lib/analytics/google-purchase';
import { readConsent } from '~/lib/site/consent';

/**
 * Fires the Google Ads Website Purchase once the marketing-site tag is loaded.
 * Reloads are a no-op: sessionStorage is keyed by the Stripe Checkout Session id.
 */
export function GooglePurchaseConversion(event: GooglePurchaseEvent): null {
  const { sendTo, value, currency, transactionId } = event;
  useEffect(() => {
    if (readConsent() === 'granted') installGoogleAds();
    const gtag = (window as Window & { gtag?: (...args: unknown[]) => void }).gtag;
    fireGooglePurchaseConversion({ sendTo, value, currency, transactionId }, gtag, sessionStorage);
  }, [sendTo, value, currency, transactionId]);
  return null;
}
