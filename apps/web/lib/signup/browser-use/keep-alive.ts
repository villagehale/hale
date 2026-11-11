/**
 * Browser Use V4 `keepAlive` is integer seconds, 120–14400. Omitting it lets
 * the API default to 14400 (four hours). Hale always sends 900 (15 minutes)
 * and only leaves the browser running for a real login or parent hand-off.
 */
export const CHECKOUT_KEEP_ALIVE_SECONDS = 900;

const PARENT_HANDOFF_DETAILS = new Set([
  'verification_code',
  'login_wall',
  'security_code',
  'waiver',
  'medical',
  'no_saved_card',
  'spending_cap',
  'price_change',
]);

/**
 * Keep the Browser Use browser open only when the parent must take over a
 * live view: a real login, or a checkout / filled-form hand-off. A generic
 * `needs_human` stop (captcha, session not found, unreadable choice) closes
 * it. `session_not_found` is never a hand-off.
 */
export function parentTakesOverLiveView(outcome: string, detail: string): boolean {
  if (outcome === 'needs_login' || outcome === 'ready_for_parent') return true;
  if (outcome === 'reached_checkout' || outcome === 'payment_not_approved') return true;
  if (outcome !== 'needs_human') return false;
  if (detail === 'session_not_found' || detail === 'captcha') return false;
  return PARENT_HANDOFF_DETAILS.has(detail);
}
