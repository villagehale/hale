/**
 * When the mobile promo bar is on screen.
 *
 * It appears after the first screen, and it stays off while the offer covers
 * the page or the footer is in view, so it never sits on the real CTA.
 *
 * The home hero is taller than one viewport and the offer begins at its foot,
 * so the offer is already in the bottom of the screen when the first-screen
 * line is crossed. That peek is not the offer covering the bar. Pricing's
 * hero is short, so the offer fills the top of the viewport until it has
 * scrolled away, which is when the bar shows there.
 */

export interface StickyCoverBlock {
  /**
   * The offer ignores a peek into the bottom half. The footer hides the bar
   * as soon as any of it is on screen.
   */
  kind: 'offer' | 'footer';
  /** Document y of the block's top and bottom edges. */
  top: number;
  bottom: number;
}

/** Scroll past this fraction of the viewport and the first screen is behind the reader. */
const PAST_FIRST_SCREEN = 0.6;

/** The offer covers the bar once its box reaches this far down the viewport. */
const OFFER_COVERS_ABOVE = 0.5;

function overlaps(top: number, bottom: number, spanTop: number, spanBottom: number): boolean {
  return bottom > spanTop && top < spanBottom;
}

export function promoStickyVisible(input: {
  scrollY: number;
  viewportHeight: number;
  blocks: readonly StickyCoverBlock[];
}): boolean {
  const { scrollY, viewportHeight, blocks } = input;
  if (!(viewportHeight > 0) || !(scrollY > viewportHeight * PAST_FIRST_SCREEN)) return false;
  const viewTop = scrollY;
  const viewBottom = scrollY + viewportHeight;
  const offerLine = scrollY + viewportHeight * OFFER_COVERS_ABOVE;
  for (const block of blocks) {
    const spanBottom = block.kind === 'footer' ? viewBottom : offerLine;
    if (overlaps(block.top, block.bottom, viewTop, spanBottom)) return false;
  }
  return true;
}
