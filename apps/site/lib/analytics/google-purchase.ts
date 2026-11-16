/**
 * Browser Google Ads Purchase on the checkout success page.
 *
 * Website conversion (send_to AW-18412881223/…). send_to comes from
 * NEXT_PUBLIC_GOOGLE_ADS_CONVERSION_SEND_TO. Value, currency, and
 * transaction_id are server-read from the Stripe Checkout Session.
 */

export const GOOGLE_PURCHASE_STORAGE_PREFIX = 'hale.google_ads_purchase.';

export interface GooglePurchaseEvent {
  readonly sendTo: string;
  readonly value: number;
  readonly currency: string;
  readonly transactionId: string;
}

export type GooglePurchaseFireResult = 'fired' | 'already_fired' | 'missing_gtag';

export function googlePurchaseStorageKey(transactionId: string): string {
  return `${GOOGLE_PURCHASE_STORAGE_PREFIX}${transactionId}`;
}

export function fireGooglePurchaseConversion(
  event: GooglePurchaseEvent,
  gtag: ((...args: unknown[]) => void) | undefined,
  storage: Pick<Storage, 'getItem' | 'setItem'>,
): GooglePurchaseFireResult {
  if (typeof gtag !== 'function') return 'missing_gtag';
  const key = googlePurchaseStorageKey(event.transactionId);
  if (storage.getItem(key) === '1') return 'already_fired';
  storage.setItem(key, '1');
  gtag('event', 'conversion', {
    send_to: event.sendTo,
    value: event.value,
    currency: event.currency,
    transaction_id: event.transactionId,
  });
  return 'fired';
}
