import { describe, expect, it } from 'vitest';
import { municipalityForCity } from './municipality-city';

describe('municipalityForCity', () => {
  it('maps Toronto’s pre-amalgamation names to Toronto', () => {
    // The City's own EarlyON feed still files centres under these.
    for (const city of ['Toronto', 'East York', 'Scarborough', 'North York', 'Etobicoke', 'York']) {
      expect(municipalityForCity(city)).toBe('toronto');
    }
  });

  it('maps the library systems’ own postal cities', () => {
    expect(municipalityForCity('Markham')).toBe('markham');
    expect(municipalityForCity('Thornhill')).toBe('markham');
    expect(municipalityForCity('Richmond Hill')).toBe('richmond_hill');
  });

  it('maps both names the Town of Whitchurch-Stouffville is filed under', () => {
    // Feeds file the same town either way; both have to land on the one token.
    expect(municipalityForCity('Stouffville')).toBe('whitchurch_stouffville');
    expect(municipalityForCity('Whitchurch-Stouffville')).toBe('whitchurch_stouffville');
  });

  it('files a York village under the township that runs its programs', () => {
    // A Nobleton or Sharon postal code resolves to nothing (L0G spans six towns), so
    // the venue's own city field is the only way these families reach the radar.
    expect(municipalityForCity('Nobleton')).toBe('king');
    expect(municipalityForCity('King City')).toBe('king');
    expect(municipalityForCity('Sharon')).toBe('east_gwillimbury');
    expect(municipalityForCity('Mount Albert')).toBe('east_gwillimbury');
    expect(municipalityForCity('Keswick')).toBe('georgina');
    expect(municipalityForCity('Sutton West')).toBe('georgina');
    expect(municipalityForCity('Newmarket')).toBe('newmarket');
    expect(municipalityForCity('Uxbridge')).toBe('uxbridge');
  });

  it('returns null for a city it does not cover, rather than the nearest guess', () => {
    expect(municipalityForCity('Kingston')).toBeNull();
    // The map is keyed on the whole city field, so "King" does not swallow Kingston
    // and Bradford West Gwillimbury is not East Gwillimbury.
    expect(municipalityForCity('Bradford West Gwillimbury')).toBeNull();
    expect(municipalityForCity('Cannington')).toBeNull();
    expect(municipalityForCity(null)).toBeNull();
  });
});
