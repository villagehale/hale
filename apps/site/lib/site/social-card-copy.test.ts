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
    // The category is now the JOB, not a noun for the software: the product's own
    // voice (the live intake greeting, /for-centres) describes finding what is on,
    // watching the sign-up morning and asking how it went — with no "assistant" in
    // it. "chief of staff" was always About-page vision language, never an
    // acquisition surface.
    expect(copy.alt).toContain('what’s on near your kids');
    expect(`${copy.headline} ${copy.subline} ${copy.alt}`).not.toContain('assistant');
    expect(copy.alt).not.toContain('chief of staff');
    // The card has room for three beats and the residency line does not fit
    // beside them; the page's own metadata still carries it (HomeMeta), and the
    // card's job is the loop. Pinned so dropping the third beat is a choice.
    expect(copy.subline).toContain('asks how it went');
  });

  it('never describes the village on the share card', () => {
    const card = socialCardCopy();
    expect(`${card.headline} ${card.subline} ${card.alt}`).not.toContain('village');
  });
});
