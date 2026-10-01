import { isShareableSignupField } from '../consent';
import {
  type BookingConnector,
  type ConnectorBookingInput,
  type ConnectorBookingResult,
  municipalBookingHost,
} from '../providers';

/**
 * Sandbox partnership booking (VIL-397).
 *
 * A fake API shape for a partner that does not exist. The call carries the
 * closed slot list and the price the parent already approved. It has no
 * partner secret, no auth header, and no payment instrument.
 * The transport refuses any host that is not `.test` or loopback, and it
 * refuses a municipal denylist host. Nothing here spends money.
 */
export const REFERENCE_CONNECTOR_ID = 'sandbox-partnership';

/** Registration host this connector claims. Exact match. Not a real partner. */
export const REFERENCE_CONNECTOR_HOST = 'book.sandbox-partner.test';

export const REFERENCE_CONNECTOR_BASE_URL_ENV = 'BOOKING_REFERENCE_CONNECTOR_BASE_URL';

export interface SandboxPartnershipBooking {
  session_id: string;
  activity_key: string;
  /** Ceiling the parent already approved. This call does not charge it. */
  approved_price_cents: number | null;
  slots: readonly { slot: string; value: string }[];
}

export interface SandboxPartnershipClient {
  createBooking(booking: SandboxPartnershipBooking): Promise<{ booked: boolean }>;
}

const SPEND_KEY = /payment|charge|card|spend|cvv|cvc|credential|secret|token|amount|price/i;

export function sandboxPartnershipBooking(input: ConnectorBookingInput): SandboxPartnershipBooking {
  const slots = input.slots.flatMap((item) => {
    if (!isShareableSignupField(item.slot)) return [];
    const value = item.value.trim();
    if (value.length === 0) return [];
    return [{ slot: item.slot, value }];
  });
  return {
    session_id: input.sessionId,
    activity_key: input.activityKey,
    approved_price_cents: input.approvedPriceCents,
    slots,
  };
}

export function sandboxPartnershipClient(
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
): SandboxPartnershipClient {
  return {
    async createBooking(booking) {
      const endpoint = sandboxEndpoint(env[REFERENCE_CONNECTOR_BASE_URL_ENV]);
      if (!endpoint) return { booked: false };
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: JSON.stringify(booking),
      });
      if (!response.ok) return { booked: false };
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        return { booked: false };
      }
      return { booked: sandboxBooked(payload) };
    },
  };
}

export function referenceBookingConnector(client: SandboxPartnershipClient): BookingConnector {
  return {
    id: REFERENCE_CONNECTOR_ID,
    matches(url) {
      return bareHost(url.hostname) === REFERENCE_CONNECTOR_HOST;
    },
    async book(input): Promise<ConnectorBookingResult> {
      let host = '';
      try {
        host = new URL(input.url).hostname;
      } catch {
        return { ok: false, reason: 'connector_failed' };
      }
      if (municipalBookingHost(host) || bareHost(host) !== REFERENCE_CONNECTOR_HOST) {
        return { ok: false, reason: 'connector_failed' };
      }
      try {
        const booked = await client.createBooking(sandboxPartnershipBooking(input));
        if (!booked.booked) return { ok: false, reason: 'connector_failed' };
        return { ok: true };
      } catch {
        return { ok: false, reason: 'connector_failed' };
      }
    },
  };
}

function sandboxEndpoint(base: string | undefined): URL | null {
  const raw = (base ?? '').trim();
  if (raw.length === 0) return null;
  let root: URL;
  try {
    root = new URL(raw);
  } catch {
    return null;
  }
  if (root.username || root.password) return null;
  const host = bareHost(root.hostname);
  if (!sandboxApiHost(host) || municipalBookingHost(host)) return null;
  const loopback = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  if (root.protocol === 'http:' && !loopback) return null;
  if (root.protocol !== 'https:' && root.protocol !== 'http:') return null;
  return new URL('/v1/bookings', root);
}

function sandboxApiHost(host: string): boolean {
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true;
  return host.endsWith('.test') && !host.startsWith('.');
}

function sandboxBooked(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const record = payload as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (SPEND_KEY.test(key)) return false;
  }
  return record.status === 'booked';
}

function bareHost(hostname: string): string {
  return hostname
    .replace(/^\[|\]$/g, '')
    .toLowerCase()
    .replace(/\.$/, '');
}
