import type { FieldSlot, SignupStopReason } from './types';

/**
 * How an authorized booking is carried out (VIL-375, VIL-397).
 *
 * Scope is anything a parent needs help booking or signing up for. The
 * exclusion is narrow: the named city sites plus ActiveNet, Xplor,
 * PerfectMind, and Amilia are a denylist (assisted handoff, never a browser
 * or a connector). Any other host is handed back, without submitting, when the
 * page shows a rush signal: waiting room or queue, captcha, resident or
 * identity verification, or a timed open-at.
 *
 * A registered connector runs first. The sandboxed browser is the fallback
 * and opens that provider's own page only. Form adapters name fields they
 * already know; they are not a category allowlist. `BOOKING_CONNECTORS` stays
 * empty. The live list is `bookingConnectors()` and is empty unless
 * BOOKING_REFERENCE_CONNECTOR_ENABLED is exactly `on`. That connector is a
 * sandbox partnership shape, not a real partner. Local mock forms are
 * ordinary loopback pages, so they take the browser path.
 */

/** A partnership API. The municipal denylist is applied before `matches`. */
export interface BookingConnector {
  readonly id: string;
  matches(url: URL): boolean;
  book(input: ConnectorBookingInput): Promise<ConnectorBookingResult>;
}

/** One closed slot. The value is sent only when the consent grant lists the slot. */
export interface ConnectorBookingSlot {
  readonly slot: FieldSlot;
  readonly value: string;
}

/**
 * What a connector may receive. Slots are the closed field list already
 * covered by the consent grant. The family record itself is not passed.
 */
export interface ConnectorBookingInput {
  url: string;
  activityKey: string;
  sessionId: string;
  approvedPriceCents: number | null;
  slots: readonly ConnectorBookingSlot[];
}

export type ConnectorBookingResult = { ok: true } | { ok: false; reason: SignupStopReason };

/**
 * Unconditionally registered connectors. Stays empty. The flag-gated sandbox
 * partnership connector is added by `bookingConnectors()`, not by this list.
 */
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
  'mississauga.ca',
  'richmondhill.ca',
  'vaughan.ca',
  'oakville.ca',
  'caledon.ca',
  'haltonhills.ca',
  'burlington.ca',
  'amilia.com',
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
