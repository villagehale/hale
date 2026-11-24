import { describe, expect, it } from 'vitest';
import { socialCardCopy } from './social-card-copy';

/**
 * The share card is the one surface a parent sees before they ever reach the page,
 * so it has to describe the page they will land on. Asserted here rather than by
 * rendering the PNG: satori would test the layout, and what can actually go wrong
 * is the copy pointing at the wrong product.
 */

describe('homepage share card copy', () => {
  it('sells the kids-year agent', () => {
    const copy = socialCardCopy();
    expect(copy.headline).toBe('Your kids’ year, handled.');
    expect(copy.subline).toBe('Hale knows your family.');
    expect(copy.alt).toBe('Hale. Your kids’ year, handled.');
    const blob = `${copy.headline} ${copy.subline} ${copy.alt}`;
    expect(blob).not.toContain('assistant');
    expect(blob).not.toContain('planner');
    expect(blob).not.toContain('chief of staff');
    expect(blob).not.toContain('number you text');
    expect(blob).not.toContain('Find what’s on');
    expect(blob).not.toContain('sign-up morning');
  });

  it('never describes the village on the share card', () => {
    const card = socialCardCopy();
    expect(`${card.headline} ${card.subline} ${card.alt}`).not.toContain('village');
  });
});
