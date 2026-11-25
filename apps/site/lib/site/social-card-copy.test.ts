import { describe, expect, it } from 'vitest';
import { socialCardCopy } from './social-card-copy';

/**
 * The share card is the one surface a parent sees before they ever reach the page.
 * The homepage line is the Style D headline. Asserted here rather than by
 * rendering the PNG: what can go wrong is the copy pointing at the wrong product.
 */

describe('homepage share card copy', () => {
  it('uses the Style D headline', () => {
    const copy = socialCardCopy();
    expect(copy.headline).toBe('From “we should” to “we’re in.”');
    expect(copy.alt).toBe('Hale. From “we should” to “we’re in.”');
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
