/**
 * Region for the marketing-site measurement banner.
 *
 * Opt-in (nothing loads until Accept): Quebec, the EU, the EEA, the United
 * Kingdom, Switzerland, and any visit whose country we cannot tell. Canada
 * with no province is opt-in, because Quebec cannot be ruled out.
 *
 * Opt-out (load on the first visit; the banner is a notice with Turn off):
 * the rest of Canada, the United States, and every other country.
 *
 * Global Privacy Control is not a region. Callers pass it separately.
 * A stored Accept or Turn off wins over the region.
 */

export type ConsentMode = 'opt-in' | 'opt-out';

/** Request header the middleware stamps from `?consent_geo=` outside production. */
export const CONSENT_GEO_HEADER = 'x-hale-consent-geo';

/**
 * ISO 3166-1 alpha-2. `UK` is not the assigned code (that is `GB`) but some
 * edges send it. `EU` is a continent bucket, not a member state: a visit
 * labeled only as Europe stays opt-in. The last group is territories a geo
 * database often labels separately that are inside the EU for this purpose.
 */
const OPT_IN_COUNTRIES = new Set([
  'AT',
  'BE',
  'BG',
  'HR',
  'CY',
  'CZ',
  'DK',
  'EE',
  'FI',
  'FR',
  'DE',
  'GR',
  'HU',
  'IE',
  'IT',
  'LV',
  'LT',
  'LU',
  'MT',
  'NL',
  'PL',
  'PT',
  'RO',
  'SK',
  'SI',
  'ES',
  'SE',
  'IS',
  'LI',
  'NO',
  'GB',
  'UK',
  'GI',
  'CH',
  'EU',
  'AX',
  'GF',
  'GP',
  'MQ',
  'RE',
  'YT',
  'MF',
  'BQ',
]);

/** Geo vendors use these when they do not know the country. That is opt-in. */
const UNKNOWN_COUNTRY = new Set(['XX', 'ZZ', 'T1', 'A1', 'A2', 'O1', 'AP']);

const COUNTRY = /^[A-Z]{2}$/;
const REGION = /^[A-Z0-9]{1,3}$/;
const OVERRIDE = /^([A-Za-z]{2})(?:-([A-Za-z0-9]{1,3}))?$/;

export function consentModeForGeo(
  country: string | null | undefined,
  region: string | null | undefined,
): ConsentMode {
  const code = normalizeCountry(country);
  if (!code || UNKNOWN_COUNTRY.has(code)) return 'opt-in';
  if (OPT_IN_COUNTRIES.has(code)) return 'opt-in';
  if (code === 'CA') {
    const province = normalizeRegion(code, region);
    if (province === 'QC' || !province) return 'opt-in';
    return 'opt-out';
  }
  return 'opt-out';
}

/**
 * Whether marketing tags may load.
 * A stored refusal always wins. A stored Accept always wins, including over
 * Global Privacy Control (that signal blocks the default, not a later choice).
 * With no stored choice, Global Privacy Control and an opt-in region load nothing.
 */
export function measurementAllowed(input: {
  stored: 'granted' | 'denied' | null;
  mode: ConsentMode;
  gpc: boolean;
}): boolean {
  if (input.stored === 'denied') return false;
  if (input.stored === 'granted') return true;
  if (input.gpc) return false;
  return input.mode === 'opt-out';
}

/** Preview and local development only. Production never honors the override. */
export function consentGeoOverrideActive(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.VERCEL_ENV !== 'production';
}

/**
 * `US`, `CA-QC`, `CA-ON`, or `unknown`. Anything else is ignored so a bad
 * query falls through to the real geo headers.
 */
export function parseConsentGeoOverride(
  raw: string | null | undefined,
): { country: string | null; region: string | null } | null {
  if (raw == null) return null;
  const text = raw.trim();
  if (!text) return null;
  if (text.toLowerCase() === 'unknown') return { country: null, region: null };
  const match = OVERRIDE.exec(text);
  const country = match?.[1];
  if (!country) return null;
  const region = match?.[2];
  return {
    country: country.toUpperCase(),
    region: region ? region.toUpperCase() : null,
  };
}

export function consentDecisionFromHeaders(
  headerList: { get(name: string): string | null },
  env: Record<string, string | undefined> = process.env,
): { mode: ConsentMode; gpc: boolean } {
  const gpc = headerList.get('sec-gpc') === '1';
  let country = headerList.get('x-vercel-ip-country');
  let region = headerList.get('x-vercel-ip-country-region');
  if (consentGeoOverrideActive(env)) {
    const override = parseConsentGeoOverride(headerList.get(CONSENT_GEO_HEADER));
    if (override) {
      country = override.country;
      region = override.region;
    }
  }
  return { mode: consentModeForGeo(country, region), gpc };
}

function normalizeCountry(country: string | null | undefined): string | null {
  if (country == null) return null;
  const code = country.trim().toUpperCase();
  if (!COUNTRY.test(code)) return null;
  return code;
}

function normalizeRegion(country: string, region: string | null | undefined): string | null {
  if (region == null) return null;
  let value = region.trim().toUpperCase();
  if (!value) return null;
  const prefix = `${country}-`;
  if (value.startsWith(prefix)) value = value.slice(prefix.length);
  if (value === 'QUEBEC') return 'QC';
  if (!REGION.test(value)) return null;
  return value;
}
