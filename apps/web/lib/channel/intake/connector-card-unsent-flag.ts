/**
 * VIL-642 — a connector card whose link never went is not a sent card.
 *
 * Off unless CONNECTOR_CARD_UNSENT_RELEASE_ENABLED is exactly `true`. A trailing
 * newline from `vercel env add`, `TRUE`, `on`, and `1` stay off. Unset stays off.
 * Unlit, a `link_unsent` claim stays accepted with the family's one-offer key held.
 */
export const CONNECTOR_CARD_UNSENT_RELEASE_ENABLED_ENV = 'CONNECTOR_CARD_UNSENT_RELEASE_ENABLED';

export function connectorCardUnsentReleaseEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[CONNECTOR_CARD_UNSENT_RELEASE_ENABLED_ENV] === 'true';
}
