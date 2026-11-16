'use client';

import { useEffect } from 'react';
import { installMetaPixel } from '~/lib/analytics/meta-pixel-client';
import {
  fireMetaPurchaseConversion,
  type MetaPurchaseEvent,
} from '~/lib/analytics/meta-purchase';
import { readConsent } from '~/lib/site/consent';

/**
 * Browser Purchase with eventID = Stripe Checkout Session id, so Meta
 * dedupes against the CAPI event. Reloads are a no-op.
 */
export function MetaPurchaseConversion(event: MetaPurchaseEvent): null {
  const { pixelId, value, currency, transactionId } = event;
  useEffect(() => {
    if (readConsent() === 'granted') installMetaPixel(pixelId);
    const fbq = (window as Window & { fbq?: (...args: unknown[]) => void }).fbq;
    fireMetaPurchaseConversion({ pixelId, value, currency, transactionId }, fbq, sessionStorage);
  }, [pixelId, value, currency, transactionId]);
  return null;
}
