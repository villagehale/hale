/**
 * The <768px "Hale is better in the app" hand-off (design handoff §5), split from
 * the React component so the phase decision is unit-testable directly (the repo's
 * render idiom is static markup with no jsdom, so the matchMedia/sessionStorage
 * behaviour is proven here as pure logic, not through a live DOM). The component
 * supplies the three inputs — the flag URL, whether the viewport is a phone, and
 * the session-scoped choice — and renders whatever phase this returns.
 */

/** Session-storage key holding the parent's dismissal choice for the current tab
 * session. Session-scoped by design (rule: no device-level persistence) — a new
 * tab starts fresh at the sheet. */
export const APP_PROMO_CHOICE_KEY = 'hale.app-promo.choice';

/** The parent's session choice: `web` = dismissed the sheet ("Continue in browser",
 * so the slim banner shows on later loads); `dismissed` = dismissed the banner too
 * (nothing shows for the rest of the session). Absent = first visit. */
export type AppPromoChoice = 'web' | 'dismissed';

export type AppPromoPhase = 'hidden' | 'sheet' | 'banner';

/**
 * What the promo shows, given the flag URL, whether we're on a phone viewport, and
 * the session choice. The flag is the honesty gate: with no App-Store URL there is
 * nothing to open, so the whole surface stays hidden (never a dead "Open" link).
 * On a phone: first visit → the bottom sheet; after "Continue in browser" → the
 * slim top banner; after the banner's ✕ → hidden for the session.
 */
export function appPromoPhase(
  url: string | undefined,
  isPhone: boolean,
  choice: AppPromoChoice | null,
): AppPromoPhase {
  if (!url) return 'hidden';
  if (!isPhone) return 'hidden';
  if (choice === 'dismissed') return 'hidden';
  if (choice === 'web') return 'banner';
  return 'sheet';
}

/** The choice value read back from sessionStorage, narrowed to the union (an
 * unexpected string reads as a fresh first visit rather than a bad state). */
export function parseAppPromoChoice(raw: string | null): AppPromoChoice | null {
  return raw === 'web' || raw === 'dismissed' ? raw : null;
}
