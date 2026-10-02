import { describe, expect, it } from 'vitest';
import { socialCardCopy } from './social-card-copy';

/**
 * The share card is the one surface a parent sees before they ever reach the page,
 * so it has to describe the page they will land on. Asserted here rather than by
 * rendering the PNG: satori would test the layout, and what can actually go wrong
 * is the copy pointing at the wrong product.
 */

describe('homepage share card copy', () => {
  it('sells the same hero the page opens on', () => {
    const copy = socialCardCopy();
    expect(copy.headline).toBe('Weekends, sorted by text.');
    expect(copy.subline).toBe('What’s on near you, this Saturday.');
    expect(copy.alt).toContain('a planner for your kids’ year');
    const blob = `${copy.headline} ${copy.subline} ${copy.alt}`;
    expect(blob).not.toContain('assistant');
    expect(copy.alt).not.toContain('chief of staff');
    expect(blob).not.toContain('number you text');
    for (const town of ['Toronto', 'Stouffville', 'Georgetown']) {
      expect(blob, town).not.toContain(town);
    }
  });

  it('never describes the village on the share card', () => {
    const card = socialCardCopy();
    expect(`${card.headline} ${card.subline} ${card.alt}`).not.toContain('village');
  });
});
