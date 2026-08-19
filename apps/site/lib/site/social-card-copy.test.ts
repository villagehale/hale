import { describe, expect, it } from 'vitest';
import { socialCardCopy } from './social-card-copy';

/**
 * The share card is the one surface a parent sees before they ever reach the page,
 * so it has to describe the page they will land on. Asserted here rather than by
 * rendering the PNG: satori would test the layout, and what can actually go wrong
 * is the copy pointing at the wrong product.
 */

describe('homepage share card copy', () => {
  it('sells the number you text', () => {
    const copy = socialCardCopy();
    expect(copy.headline).toBe('A number your family texts');
    // "Family assistant" is the category a parent can place without translation;
    // "chief of staff" is About-page vision language, never an acquisition surface.
    expect(copy.alt).toContain('family assistant');
    expect(copy.alt).not.toContain('chief of staff');
    expect(copy.subline).toContain('Your data stays in Canada.');
  });

  it('never describes the village on the share card', () => {
    const card = socialCardCopy();
    expect(`${card.headline} ${card.subline} ${card.alt}`).not.toContain('village');
  });
});
