import { describe, expect, it } from 'vitest';
import { normalizeLocation } from './location-input.js';

describe('normalizeLocation', () => {
  it('trims each field and derives areaCoarse from the Canadian FSA (rule #1: coarse)', () => {
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
      // areaCoarse is the FSA only — never the full postal code.
      areaCoarse: 'M5V',
    });
  });

  it('upper-cases the postal code and collapses inner whitespace', () => {
    expect(normalizeLocation({ postalCode: 'm5v   2t6' }).postalCode).toBe('M5V 2T6');
  });

  it('derives a UK outward code (part before the space)', () => {
    expect(normalizeLocation({ postalCode: 'SW1A 1AA' }).areaCoarse).toBe('SW1A');
  });

  it('derives a US ZIP3 when the postal code has no space', () => {
    expect(normalizeLocation({ postalCode: '90210' }).areaCoarse).toBe('902');
  });

  it('falls back to the city for areaCoarse when no postal code is given', () => {
    expect(normalizeLocation({ city: 'Toronto' }).areaCoarse).toBe('Toronto');
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
});
