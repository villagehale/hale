import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const CARD_SOURCES = [
  './opengraph-image.tsx',
  './answers/[slug]/opengraph-image.tsx',
  './milestones/[age]/opengraph-image.tsx',
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

  it('uses the real Hale logo rather than a placeholder circle', () => {
    expect(BRAND_SOURCE).toContain("new URL('/icon.png', SITE_URL)");
    expect(BRAND_SOURCE).not.toContain('borderRadius: 9999');

    for (const source of CARD_SOURCES) {
      expect(source).toContain('SocialCardBrand');
      expect(source).not.toContain('borderRadius: 9999');
    }
  });
});
