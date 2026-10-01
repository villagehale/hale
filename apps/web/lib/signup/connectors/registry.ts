import type { BookingConnector } from '../providers';
import { referenceConnectorEnabled } from './flag';
import { referenceBookingConnector, sandboxPartnershipClient } from './reference';

/**
 * Partnership connectors that may run before the sandbox browser.
 *
 * Empty unless BOOKING_REFERENCE_CONNECTOR_ENABLED is exactly `on`. The
 * municipal denylist is applied by `bookingRoute` before any connector
 * `matches`, so this list cannot opt a denied host into automation.
 */
export function bookingConnectors(
  env: Record<string, string | undefined> = process.env,
): readonly BookingConnector[] {
  if (!referenceConnectorEnabled(env)) return [];
  return [referenceBookingConnector(sandboxPartnershipClient(env))];
}
