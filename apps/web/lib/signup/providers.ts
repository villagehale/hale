import type { FieldSlot, SignupStopReason } from './types';

/**
 * How an authorized booking is carried out (VIL-375, VIL-397).
 *
 * Scope is any provider registration site. There is no host denylist and no
 * allowlist. Any host is handed back, without submitting, when the page shows
 * a rush signal: waiting room or queue, captcha, resident or identity
 * verification, or a timed open-at.
 *
 * A registered connector runs first. The sandboxed browser is the fallback
 * and opens that provider's own page only. Form adapters name fields they
 * already know; they are not a category allowlist. `BOOKING_CONNECTORS` stays
 * empty. The live list is `bookingConnectors()` and is empty unless
 * BOOKING_REFERENCE_CONNECTOR_ENABLED is exactly `on`. That connector is a
 * sandbox partnership shape, not a real partner. Local mock forms are
 * ordinary loopback pages, so they take the browser path.
 */

/** A partnership API. */
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

export type BookingRoute = { kind: 'connector'; connector: BookingConnector } | { kind: 'browser' };

/** A matching connector first, then the browser on this URL. */
export function bookingRoute(
  href: string,
  connectors: readonly BookingConnector[] = BOOKING_CONNECTORS,
): BookingRoute {
  const url = new URL(href);
  const connector = connectors.find((candidate) => candidate.matches(url));
  if (connector) return { kind: 'connector', connector };
  return { kind: 'browser' };
}
