import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const CARD_SOURCE = readFileSync(
  fileURLToPath(new URL('../lib/site/share-card.tsx', import.meta.url)),
  'utf8',
);
const COPY_SOURCE = readFileSync(
  fileURLToPath(new URL('../lib/site/share-cards.ts', import.meta.url)),
  'utf8',
);

describe('marketing share-card design system', () => {
  it('paints Style D: notes paper, yellow marker, iMessage blue, the turtle', () => {
    expect(CARD_SOURCE).toContain('#FFF8DC');
    expect(CARD_SOURCE).toContain('#FFE066');
    expect(CARD_SOURCE).toContain('#0A84FF');
    expect(CARD_SOURCE).toContain('#E9E9EB');
    expect(CARD_SOURCE).toContain('#1C1C1E');
    expect(CARD_SOURCE).toContain('Caveat Brush');
    expect(CARD_SOURCE).toContain("readSiteFile('app', 'icon.png')");
    expect(CARD_SOURCE).not.toContain('hale-shore-og.png');
    expect(CARD_SOURCE).not.toContain('SocialCardBrand');
    expect(CARD_SOURCE).not.toContain('villagehale.com');
  });

  it('takes prices from the holiday promo helper, not a second set of numbers', () => {
    expect(COPY_SOURCE).toContain('buildHolidayPromo');
    expect(COPY_SOURCE).not.toContain('$59');
    expect(COPY_SOURCE).not.toContain('$39');
    expect(COPY_SOURCE).not.toContain('$99');
    expect(COPY_SOURCE).not.toContain('$79');
  });
});
