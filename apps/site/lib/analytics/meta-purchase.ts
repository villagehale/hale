/**
 * Browser Meta Pixel Purchase on the checkout success page.
 *
 * CAPI is the source of truth and posts to the first pixel id only. This event
 * uses the Stripe Checkout Session id as eventID so Meta dedupes the two.
 * `fbq('track')` sends the Purchase, with that same eventID, to every pixel
 * already initialized. Value and currency come from Stripe.
 */

export const META_PURCHASE_STORAGE_PREFIX = 'hale.meta_purchase.';

export interface MetaPurchaseEvent {
  readonly pixelId: string;
  readonly value: number;
  readonly currency: string;
  readonly transactionId: string;
}

export type MetaPurchaseFireResult = 'fired' | 'already_fired' | 'missing_fbq';

export function metaPurchaseStorageKey(transactionId: string): string {
  return `${META_PURCHASE_STORAGE_PREFIX}${transactionId}`;
}

export function fireMetaPurchaseConversion(
  event: MetaPurchaseEvent,
  fbq: ((...args: unknown[]) => void) | undefined,
  storage: Pick<Storage, 'getItem' | 'setItem'>,
): MetaPurchaseFireResult {
  if (typeof fbq !== 'function') return 'missing_fbq';
  const key = metaPurchaseStorageKey(event.transactionId);
  if (storage.getItem(key) === '1') return 'already_fired';
  storage.setItem(key, '1');
  fbq(
    'track',
    'Purchase',
    { value: event.value, currency: event.currency },
    { eventID: event.transactionId },
  );
  return 'fired';
}
