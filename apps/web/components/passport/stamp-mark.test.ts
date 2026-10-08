import { describe, expect, it } from 'vitest';
import { STAMP_PROFILES, miniIconPlacement, stampTilt } from './stamp-mark';

const TABLE: Record<string, { shape: string; ink: string }> = {
  soccer: { shape: 'circle', ink: '#1B2160' },
  swimming: { shape: 'rect', ink: '#2E6DA4' },
  skating: { shape: 'oct', ink: '#0F766E' },
  zoo: { shape: 'oval', ink: '#9A3B26' },
  karate: { shape: 'shield', ink: '#5B3A7A' },
  aquarium: { shape: 'circle', ink: '#3F6B3A' },
  ballet: { shape: 'rect', ink: '#1B2160' },
  farm: { shape: 'oct', ink: '#2E6DA4' },
  hockey: { shape: 'oval', ink: '#0F766E' },
  basketball: { shape: 'shield', ink: '#9A3B26' },
  taekwondo: { shape: 'circle', ink: '#5B3A7A' },
  dance: { shape: 'rect', ink: '#3F6B3A' },
  'figure-skating': { shape: 'oct', ink: '#1B2160' },
  golf: { shape: 'oval', ink: '#2E6DA4' },
  mma: { shape: 'shield', ink: '#0F766E' },
  gymnastics: { shape: 'circle', ink: '#9A3B26' },
  baseball: { shape: 'rect', ink: '#5B3A7A' },
  skiing: { shape: 'oct', ink: '#3F6B3A' },
  museum: { shape: 'oval', ink: '#1B2160' },
  'christmas-market': { shape: 'shield', ink: '#2E6DA4' },
};

describe('stamp gallery', () => {
  it('gives each activity the gallery shape and ink', () => {
    for (const [icon, expected] of Object.entries(TABLE)) {
      expect(STAMP_PROFILES[icon]).toMatchObject(expected);
    }
  });

  it('seeds rotation from the stamp id inside −8° to +7°', () => {
    const tilts = ['preview-soccer', 'preview-karate', 'preview-leo-hockey'].map(stampTilt);
    for (const tilt of tilts) {
      expect(tilt).toBeGreaterThanOrEqual(-8);
      expect(tilt).toBeLessThanOrEqual(7);
    }
    expect(new Set(tilts).size).toBeGreaterThan(1);
  });

  it('draws the real icon at 14–16px with a 2px stroke inside the 26px mini', () => {
    const { transform, strokeWidth } = miniIconPlacement();
    const scale = (20 / 24) * (120 / 26);
    expect(transform).toBe(`translate(${60 - 12 * scale} ${60 - 12 * scale}) scale(${scale})`);
    expect(strokeWidth).toBeCloseTo(2 / ((26 / 120) * scale), 5);
  });
});
