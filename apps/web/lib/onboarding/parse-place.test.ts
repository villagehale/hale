import { describe, expect, it } from 'vitest';
import { type PlaceAddressComponent, parsePlaceAddress } from './parse-place.js';

function c(types: string[], longText: string, shortText: string): PlaceAddressComponent {
  return { types, longText, shortText };
}

describe('parsePlaceAddress', () => {
  it('maps a Canadian address to country / province (code) / city / postal code', () => {
    const components = [
      c(['street_number'], '290', '290'),
      c(['route'], 'Bremner Boulevard', 'Bremner Blvd'),
      c(['locality', 'political'], 'Toronto', 'Toronto'),
      c(['administrative_area_level_1', 'political'], 'Ontario', 'ON'),
      c(['country', 'political'], 'Canada', 'CA'),
      c(['postal_code'], 'M5V 3L9', 'M5V 3L9'),
    ];
    expect(parsePlaceAddress(components)).toEqual({
      country: 'Canada',
      province: 'ON',
      city: 'Toronto',
      postalCode: 'M5V 3L9',
    });
  });

  it('drops the street line entirely (rule #1: not stored here)', () => {
    const result = parsePlaceAddress([
      c(['street_number'], '290', '290'),
      c(['route'], 'Bremner Boulevard', 'Bremner Blvd'),
    ]);
    expect(result).toEqual({
      country: undefined,
      province: undefined,
      city: undefined,
      postalCode: undefined,
    });
  });

  it('falls back to postal_town for the city when there is no locality (UK)', () => {
    const components = [
      c(['postal_town'], 'London', 'London'),
      c(['administrative_area_level_1', 'political'], 'England', 'England'),
      c(['country', 'political'], 'United Kingdom', 'GB'),
      c(['postal_code'], 'SW1A 1AA', 'SW1A 1AA'),
    ];
    expect(parsePlaceAddress(components).city).toBe('London');
  });

  it('uses administrative_area_level_2 as a last-resort city', () => {
    const components = [
      c(['administrative_area_level_2', 'political'], 'Snohomish County', 'Snohomish County'),
      c(['country', 'political'], 'United States', 'US'),
    ];
    expect(parsePlaceAddress(components).city).toBe('Snohomish County');
  });
});
