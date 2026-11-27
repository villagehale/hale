import { describe, expect, it } from 'vitest';
import { type StickyCoverBlock, promoStickyVisible } from './sticky-visibility';

/**
 * Measured on the live homepage and /pricing at 390×844.
 * The home offer starts at the foot of a hero taller than the viewport, so it
 * is already inside the screen when the reader has only just passed the first
 * screen. Pricing's hero is short, so the same scroll is still inside the offer.
 */
const VH = 844;

const HOME_OFFER: StickyCoverBlock = { kind: 'offer', top: 1234, bottom: 2535 };
const HOME_FOOTER: StickyCoverBlock = { kind: 'footer', top: 9240, bottom: 9989 };
const PRICING_OFFER: StickyCoverBlock = { kind: 'offer', top: 483, bottom: 1752 };
const PRICING_FOOTER: StickyCoverBlock = { kind: 'footer', top: 4664, bottom: 5413 };

function visible(
  scrollY: number,
  blocks: readonly StickyCoverBlock[],
  viewportHeight = VH,
): boolean {
  return promoStickyVisible({ scrollY, viewportHeight, blocks });
}

describe('promo sticky on the homepage', () => {
  const blocks = [HOME_OFFER, HOME_FOOTER];

  it('stays hidden on the first screen', () => {
    expect(visible(0, blocks)).toBe(false);
    expect(visible(200, blocks)).toBe(false);
  });

  it('shows once the first screen is past and the offer is only peeking in at the bottom', () => {
    // scrollY 700 is past 0.6×844. The offer top (1234) is still in the lower
    // half of the viewport, which is why a full-viewport intersection kept
    // data-show false for the whole hero.
    expect(visible(700, blocks)).toBe(true);
  });

  it('hides while the offer fills the page, then shows again until the footer', () => {
    expect(visible(1400, blocks)).toBe(false);
    expect(visible(3200, blocks)).toBe(true);
    expect(visible(8000, blocks)).toBe(true);
  });

  it('hides when the footer is on screen, including at the bottom of a full scroll', () => {
    expect(visible(9100, blocks)).toBe(false);
  });
});

describe('promo sticky on pricing', () => {
  const blocks = [PRICING_OFFER, PRICING_FOOTER];

  it('stays hidden until the reader has left the first screen and the offer', () => {
    expect(visible(200, blocks)).toBe(false);
    expect(visible(900, blocks)).toBe(false);
    expect(visible(2000, blocks)).toBe(true);
  });

  it('hides again over the footer', () => {
    expect(visible(4500, blocks)).toBe(false);
  });
});
