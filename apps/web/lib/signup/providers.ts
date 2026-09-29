import type { SignupIdentity, SignupStopReason } from './types';

/**
 * How an authorized booking is carried out (VIL-375).
 *
 * City recreation is out of scope. Toronto, Brampton, and Markham, and the
 * ActiveNet, Xplor, and PerfectMind hosts those programs run on, are a denylist:
 * assisted handoff only (deep link plus a prefilled pack), never a browser and
 * never a connector.
 *
 * Every other official booking page is in scope: a registered connector or API
 * runs first, and the sandboxed browser is the fallback. The browser opens that
 * page and does not go looking for another one. No connector is registered yet.
 * Local mock forms are ordinary loopback pages, so they take the browser path.
 */

/** A partnership or official API. Empty until one is actually agreed. */
export interface BookingConnector {
  readonly id: string;
  matches(url: URL): boolean;
  book(input: ConnectorBookingInput): Promise<ConnectorBookingResult>;
}

export interface ConnectorBookingInput {
  url: string;
  activityKey: string;
  sessionId: string;
  approvedPriceCents: number | null;
  identity: SignupIdentity;
}

export type ConnectorBookingResult = { ok: true } | { ok: false; reason: SignupStopReason };

/** None. A connector is added here when a provider has an API Hale may call. */
export const BOOKING_CONNECTORS: readonly BookingConnector[] = [];

/**
 * Hosts Hale does not automate. Suffix match, so a subdomain is denied with
 * the registrable name. `nottoronto.ca` is not `toronto.ca`.
 */
export const BOOKING_DENY_SUFFIXES = [
  'activecommunities.com',
  'activenetwork.com',
  'perfectmind.com',
  'xplorrecreation.com',
  'toronto.ca',
  'brampton.ca',
  'markham.ca',
] as const;

export type BookingRoute =
  | { kind: 'handoff' }
  | { kind: 'connector'; connector: BookingConnector }
  | { kind: 'browser' };

export function municipalBookingHost(hostname: string): boolean {
  const host = hostname
    .replace(/^\[|\]$/g, '')
    .toLowerCase()
    .replace(/\.$/, '');
  return BOOKING_DENY_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

/**
 * Denylist first, then a matching connector, then the browser on this URL.
 * A connector cannot opt a denied host back into automation.
 */
export function bookingRoute(
  href: string,
  connectors: readonly BookingConnector[] = BOOKING_CONNECTORS,
): BookingRoute {
  const url = new URL(href);
  if (municipalBookingHost(url.hostname)) return { kind: 'handoff' };
  const connector = connectors.find((candidate) => candidate.matches(url));
  if (connector) return { kind: 'connector', connector };
  return { kind: 'browser' };
}
