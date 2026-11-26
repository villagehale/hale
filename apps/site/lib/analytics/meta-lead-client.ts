import { readConsent } from '~/lib/site/consent';
import { fireMetaLead, storedMetaLeadId } from './meta-browser';

/**
 * One Lead for the first consented tap that opens /text or an sms composer.
 * The pixel and the Conversions API share the event id in sessionStorage.
 * A second tap in the tab does not send again. No pixel means Accept has not
 * happened, and this does not load one.
 */

export function reportMetaLeadTap(): void {
  if (typeof window === 'undefined') return;
  if (readConsent() !== 'granted') return;
  const fbq = (window as Window & { fbq?: (...args: unknown[]) => void }).fbq;
  if (typeof fbq !== 'function') return;
  let storage: Pick<Storage, 'getItem' | 'setItem'>;
  try {
    storage = window.sessionStorage;
  } catch {
    return;
  }
  const status = fireMetaLead(fbq, storage);
  if (status !== 'fired') return;
  const eventId = storedMetaLeadId(storage);
  if (!eventId) return;
  void fetch('/api/analytics/meta-lead', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ event_id: eventId }),
    keepalive: true,
    credentials: 'same-origin',
  }).catch(() => {
    // The pixel already fired. A failed CAPI post is Meta's dedupe window, not a blocked tap.
  });
}
