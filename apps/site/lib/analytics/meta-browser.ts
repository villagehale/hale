/**
 * Browser pixel events that dedupe with Conversions API on eventID.
 *
 * PageView stays in installMetaPixel. These helpers do not install the pixel
 * and do not call track PageView. fbq is absent until Accept, which is the
 * same gate as the pixel itself.
 */

export const META_LEAD_STORAGE_KEY = 'hale.meta_lead';

const CHECKOUT_EVENT_ID = /^cs_[A-Za-z0-9_]+$/;
const LEAD_EVENT_ID = /^lead_[a-f0-9]{32}$/;

export type MetaPixelFire = 'fired' | 'already_fired' | 'missing_fbq' | 'refused';

type Fbq = ((...args: unknown[]) => void) | undefined;

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

export function metaLeadEventId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `lead_${hex}`;
}

export function metaInitiateStorageKey(eventId: string): string {
  return `hale.meta_ic.${eventId}`;
}

export function fireMetaInitiateCheckout(
  event: { eventId: string; value: number; currency: string },
  fbq: Fbq,
  storage: StorageLike,
): MetaPixelFire {
  if (typeof fbq !== 'function') return 'missing_fbq';
  if (!CHECKOUT_EVENT_ID.test(event.eventId)) return 'refused';
  if (event.currency !== 'CAD' && event.currency !== 'USD') return 'refused';
  if (!Number.isFinite(event.value) || event.value < 0) return 'refused';
  const key = metaInitiateStorageKey(event.eventId);
  if (storage.getItem(key) === '1') return 'already_fired';
  storage.setItem(key, '1');
  fbq(
    'track',
    'InitiateCheckout',
    { value: event.value, currency: event.currency },
    { eventID: event.eventId },
  );
  return 'fired';
}

export function fireMetaLead(
  fbq: Fbq,
  storage: StorageLike,
  eventId = metaLeadEventId(),
): MetaPixelFire {
  if (typeof fbq !== 'function') return 'missing_fbq';
  if (!LEAD_EVENT_ID.test(eventId)) return 'refused';
  const existing = storage.getItem(META_LEAD_STORAGE_KEY);
  if (existing) return 'already_fired';
  storage.setItem(META_LEAD_STORAGE_KEY, eventId);
  fbq('track', 'Lead', {}, { eventID: eventId });
  return 'fired';
}

export function storedMetaLeadId(storage: Pick<Storage, 'getItem'>): string | null {
  const value = storage.getItem(META_LEAD_STORAGE_KEY);
  return value && LEAD_EVENT_ID.test(value) ? value : null;
}
