import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SHARE_CARDS } from '~/lib/site/share-cards';

const CARD_SOURCE = readFileSync(
  fileURLToPath(new URL('../lib/site/share-card.tsx', import.meta.url)),
  'utf8',
);
const BRAND_SOURCE = readFileSync(
  fileURLToPath(new URL('../components/social-card-brand.tsx', import.meta.url)),
  'utf8',
);

describe('marketing share-card design system', () => {
  it('paints the light homepage: page canvas, navy type, amber rule, site iMessage colors', () => {
    expect(BRAND_SOURCE).toContain('#17294A');
    expect(BRAND_SOURCE).toContain('#B26B1F');
    expect(CARD_SOURCE).toContain('#fdfcfa');
    expect(CARD_SOURCE).toContain('#17294a');
    expect(CARD_SOURCE).toContain('#b26b1f');
    expect(CARD_SOURCE).toContain('#0088ff');
    expect(CARD_SOURCE).toContain('#e9e9eb');
    expect(CARD_SOURCE).toContain('hale-shore-og.png');
    expect(CARD_SOURCE).toContain('SocialCardBrand');
    expect(CARD_SOURCE).toContain('villagehale.com');
    expect(CARD_SOURCE).not.toContain('backgroundColor: SOCIAL_CARD_PALETTE.navy');
    expect(CARD_SOURCE).not.toContain('borderRadius: 9999');
  });

  it('uses the real Hale logo rather than a placeholder circle', () => {
    expect(BRAND_SOURCE).toContain("new URL('/icon.png', SITE_URL)");
    expect(BRAND_SOURCE).not.toContain('borderRadius: 9999');
  });

  it('puts the chat mock only on home and pricing, and never a price', () => {
    expect(SHARE_CARDS.home.chat).toBe(true);
    expect(SHARE_CARDS.pricing.chat).toBe(true);
    expect(SHARE_CARDS.faq.chat).toBeUndefined();
    const painted = Object.values(SHARE_CARDS)
      .flatMap((card) => [card.alt, card.headline, 'subline' in card ? card.subline : ''])
      .join('\n');
    expect(painted).not.toMatch(/\$\d|C\$|US\$|\bfree\b|planner|helper that plans/i);
    expect(painted).not.toContain('Find what’s on');
    expect(painted).not.toContain('sign-up morning');
  });
});
