import { describe, expect, it } from 'vitest';
import { normalizeLocation } from './location-input.js';

describe('normalizeLocation', () => {
  it('trims each field and mirrors the postal code into areaCoarse', () => {
    expect(
      normalizeLocation({
        country: ' Canada ',
        province: ' Ontario ',
        city: ' Toronto ',
        postalCode: ' m5v 2t6 ',
      }),
    ).toEqual({
      country: 'Canada',
      province: 'Ontario',
      city: 'Toronto',
      postalCode: 'M5V 2T6',
      areaCoarse: 'M5V 2T6',
    });
  });

  it('upper-cases the postal code and collapses inner whitespace', () => {
    expect(normalizeLocation({ postalCode: 'm5v   2t6' }).postalCode).toBe('M5V 2T6');
  });

  it('turns empty / whitespace-only fields into null (opt-out of local discovery)', () => {
    expect(normalizeLocation({ country: '   ', postalCode: '' })).toEqual({
      country: null,
      province: null,
      city: null,
      postalCode: null,
      areaCoarse: null,
    });
  });

  it('keeps areaCoarse null when no postal code is given', () => {
    expect(normalizeLocation({ city: 'Toronto' }).areaCoarse).toBeNull();
  });
});
