import { afterEach, describe, expect, it, vi } from 'vitest';
import { F14_LANDING_ENV } from '~/lib/flags/landing';
import { socialCardCopy } from './social-card-copy';

/**
 * The share card is the one surface a parent sees before they ever reach the page,
 * so it has to describe the page they will land on. Both variants are asserted
 * here rather than by rendering the PNG: satori would test the layout, and what
 * can actually go wrong is the copy pointing at the wrong product.
 */

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('homepage share card copy', () => {
  it('sells the number you text once the F14 landing is flipped on', () => {
    vi.stubEnv(F14_LANDING_ENV, 'true');
    const copy = socialCardCopy();
    expect(copy.headline).toBe('A number your family texts');
    expect(copy.alt).toContain('chief of staff');
    expect(copy.subline).toContain('Your data stays in Canada.');
  });

  it('stays on the village card while the landing is dark', () => {
    vi.stubEnv(F14_LANDING_ENV, '');
    const copy = socialCardCopy();
    expect(copy.headline).toBe('The village every parent needs');
    expect(copy.alt).toBe('Hale — the village every parent needs');
  });

  it('never describes the village on the chief-of-staff card, or the reverse', () => {
    vi.stubEnv(F14_LANDING_ENV, 'true');
    const chief = socialCardCopy();
    expect(`${chief.headline} ${chief.subline} ${chief.alt}`).not.toContain('village');

    vi.stubEnv(F14_LANDING_ENV, '');
    const village = socialCardCopy();
    expect(`${village.headline} ${village.subline} ${village.alt}`).not.toContain('texts');
  });
});
