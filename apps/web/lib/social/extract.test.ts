import { describe, expect, it } from 'vitest';
import {
  PLACEHOLDER_CONFIDENCE_CEILING,
  extractSocialSpot,
  extractSocialSpotPlaceholder,
} from './extract';

describe('extractSocialSpotPlaceholder', () => {
  it('stays at zero confidence on an empty caption', () => {
    const spot = extractSocialSpotPlaceholder('', "Downey's Farm");
    expect(spot.confidence).toBe(0);
    expect(spot.title).toBe("Downey's Farm");
    expect(spot.method).toBe('placeholder');
  });

  it('reads a stated age band as completed years and a non-instagram registration url', () => {
    const spot = extractSocialSpotPlaceholder(
      'Ages 3-5 years. Tickets https://downeysfarm.com/pumpkinfest',
      'Farm',
    );
    expect(spot.ageMin).toBe(3);
    expect(spot.ageMax).toBe(5);
    expect(spot.registrationUrl).toBe('https://downeysfarm.com/pumpkinfest');
  });

  it('treats a dated caption that says registration opens as a signup clock, not a start', () => {
    const spot = extractSocialSpotPlaceholder(
      'Registration opens 2026-10-01T09:00:00-04:00 for ages 4 years',
      'Camp',
    );
    expect(spot.registrationOpensAt?.toISOString()).toBe('2026-10-01T13:00:00.000Z');
    expect(spot.startsAt).toBeNull();
  });

  it('does not treat an instagram permalink as a registration url', () => {
    const spot = extractSocialSpotPlaceholder(
      'See https://www.instagram.com/p/abc/ for ages 2 years on 2026-10-04',
      'Centre',
    );
    expect(spot.registrationUrl).toBeNull();
    expect(spot.startsAt).not.toBeNull();
    expect(spot.confidence).toBeLessThanOrEqual(PLACEHOLDER_CONFIDENCE_CEILING);
  });
});

describe('extractSocialSpot', () => {
  it('uses the placeholder when no model client is passed', async () => {
    const spot = await extractSocialSpot('Ages 2-4 years', 'EarlyON', {});
    expect(spot.method).toBe('placeholder');
    expect(spot.ageMin).toBe(2);
  });
});
