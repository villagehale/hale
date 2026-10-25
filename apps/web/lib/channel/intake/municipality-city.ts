import type { Municipality } from '@hale/db';

/** Whole-city matching for the existing first-touch place reader; unknown cities stay unknown. */
const CITY_TO_MUNICIPALITY: Readonly<Record<string, Municipality>> = {
  toronto: 'toronto',
  'east york': 'toronto',
  'north york': 'toronto',
  scarborough: 'toronto',
  etobicoke: 'toronto',
  york: 'toronto',
  markham: 'markham',
  thornhill: 'markham',
  unionville: 'markham',
  'richmond hill': 'richmond_hill',
  vaughan: 'vaughan',
  mississauga: 'mississauga',
  stouffville: 'whitchurch_stouffville',
  'whitchurch-stouffville': 'whitchurch_stouffville',
  newmarket: 'newmarket',
  // The villages are safe HERE and nowhere else: this matches a venue's structured
  // city field, not free text, so "Sharon" is a postal city and never a given name.
  king: 'king',
  'king city': 'king',
  'king township': 'king',
  nobleton: 'king',
  schomberg: 'king',
  kettleby: 'king',
  'east gwillimbury': 'east_gwillimbury',
  'holland landing': 'east_gwillimbury',
  sharon: 'east_gwillimbury',
  'mount albert': 'east_gwillimbury',
  queensville: 'east_gwillimbury',
  georgina: 'georgina',
  keswick: 'georgina',
  sutton: 'georgina',
  'sutton west': 'georgina',
  pefferlaw: 'georgina',
  "jackson's point": 'georgina',
  'jacksons point': 'georgina',
  uxbridge: 'uxbridge',
};

export function municipalityForCity(city: string | null): Municipality | null {
  if (city === null) return null;
  return CITY_TO_MUNICIPALITY[city.trim().toLowerCase()] ?? null;
}
