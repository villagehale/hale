/**
 * VIL-397 — sandbox partnership connector.
 *
 * Off unless BOOKING_REFERENCE_CONNECTOR_ENABLED is exactly `on` after trim.
 * `true`, `1`, and `ON` stay off. Unset stays off. This flag does not turn on
 * authorized signup, and authorized signup does not turn this flag on.
 */
export const REFERENCE_CONNECTOR_ENABLED_ENV = 'BOOKING_REFERENCE_CONNECTOR_ENABLED';

export function referenceConnectorEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return (env[REFERENCE_CONNECTOR_ENABLED_ENV] ?? '').trim() === 'on';
}
