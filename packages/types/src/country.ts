/** The two countries Hale serves. */
export type FamilyCountry = 'CA' | 'US';

/**
 * The names a family's row may hold for the two countries Hale serves. Canada's are the
 * ones onboarding's region gate accepts (location-input.ts keeps that set to itself, and
 * it means "cleared to onboard", which is not this question). A Map, because the key is
 * stored text and a plain object also answers to `constructor`.
 */
const COUNTRY_FOR_NAME: ReadonlyMap<string, FamilyCountry> = new Map([
  ['canada', 'CA'],
  ['ca', 'CA'],
  ['can', 'CA'],
  ['united states', 'US'],
  ['united states of america', 'US'],
  ['usa', 'US'],
  ['us', 'US'],
]);

/** The country a stored country names, or undefined for one Hale does not serve. */
export function postalCountryOf(country: string): FamilyCountry | undefined {
  return COUNTRY_FOR_NAME.get(country.trim().toLowerCase());
}

/** The family row's country, or null when the row has none Hale serves. Never a guess. */
export function familyCountryOf(stored: string | null): FamilyCountry | null {
  return stored === null ? null : (postalCountryOf(stored) ?? null);
}
