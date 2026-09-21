import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { socialCardCopy } from '~/lib/site/social-card-copy';

// The milestones/[age] card went with its page in the receipts-room slimdown: the
// route is a permanent redirect now, so there is nothing left for it to be the card of.
const CARD_SOURCES = [
  './[locale]/opengraph-image.tsx',
  './[locale]/answers/[slug]/opengraph-image.tsx',
].map((path) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8'));
const BRAND_SOURCE = readFileSync(
  fileURLToPath(new URL('../components/social-card-brand.tsx', import.meta.url)),
  'utf8',
);

describe('marketing share-card design system', () => {
  it('uses the current navy/cream/amber palette across every card', () => {
    expect(BRAND_SOURCE).toContain('#17294A');
    expect(BRAND_SOURCE).toContain('#F7F4EC');
    expect(BRAND_SOURCE).toContain('#B26B1F');

    for (const source of CARD_SOURCES) {
      expect(source).toContain('SOCIAL_CARD_PALETTE');
      expect(source).not.toContain('#003153');
      expect(source).not.toContain('#f97316');
      expect(source).not.toContain('#faf7f1');
    }
  });

  it('takes the homepage card’s words from socialCardCopy, and sells no assistant', () => {
    // The card is the one surface that can ship a stale sentence invisibly: nobody
    // on the team looks at it, and it is the first thing a stranger reads when the
    // link lands in a parent group chat. So the source must READ the copy module
    // rather than inline a headline, and the copy module must not carry the noun
    // the positioning sweep removed.
    const home = readFileSync(
      fileURLToPath(new URL('./[locale]/opengraph-image.tsx', import.meta.url)),
      'utf8',
    );
    expect(home).toContain('socialCardCopy');
    expect(home).toContain('copy.headline');
    expect(home).toContain('copy.subline');
    const copy = socialCardCopy();
    for (const words of [copy.alt, copy.headline, copy.subline]) {
      expect(words).not.toContain('assistant');
      // Positive control: there ARE words, so "no assistant" is a sentence that
      // was rewritten rather than a card that renders empty.
      expect(words.length).toBeGreaterThan(20);
    }
  });

  it('uses the real Hale logo rather than a placeholder circle', () => {
    expect(BRAND_SOURCE).toContain("new URL('/icon.png', SITE_URL)");
    expect(BRAND_SOURCE).not.toContain('borderRadius: 9999');

    for (const source of CARD_SOURCES) {
      expect(source).toContain('SocialCardBrand');
      expect(source).not.toContain('borderRadius: 9999');
    }
  });
});
