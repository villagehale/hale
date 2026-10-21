const CANADIAN_REGIONS: Readonly<Record<string, string>> = {
  AB: 'Alberta',
  BC: 'British Columbia',
  MB: 'Manitoba',
  NB: 'New Brunswick',
  NL: 'Newfoundland and Labrador',
  NS: 'Nova Scotia',
  NT: 'Northwest Territories',
  NU: 'Nunavut',
  ON: 'Ontario',
  PE: 'Prince Edward Island',
  QC: 'Quebec',
  SK: 'Saskatchewan',
  YT: 'Yukon',
};

const COUNTRIES = [
  ['Canada', 'CA', 'CAN'],
  ['United States', 'US', 'USA', 'United States of America'],
  [
    'United Kingdom',
    'UK',
    'GB',
    'Great Britain',
    'England',
    'Scotland',
    'Wales',
    'Northern Ireland',
  ],
];

function canadianRegion(value: string) {
  return Object.entries(CANADIAN_REGIONS).find(
    ([code, name]) => code === value.toUpperCase() || name.toLowerCase() === value.toLowerCase(),
  );
}

function countryName(value: string): string {
  return (
    COUNTRIES.find((names) =>
      names.some((name) => name.toLowerCase() === value.toLowerCase()),
    )?.[0] ?? value
  );
}

export function qualifyActivityLocation(
  city: string,
  province?: string | null,
  country?: string | null,
): string {
  if (!city.trim()) return '';
  const region = province?.trim() ? canadianRegion(province.trim()) : undefined;
  return [
    city.trim(),
    region?.[1] ?? province?.trim(),
    country?.trim() ? countryName(country.trim()) : region ? 'Canada' : null,
  ]
    .filter(Boolean)
    .join(', ');
}

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const CANADIAN_POSTAL_CODE =
  '[ABCEGHJ-NPRSTVXY]\\d[ABCEGHJ-NPRSTVWXYZ]\\s?\\d[ABCEGHJ-NPRSTVWXYZ]\\d';

/** Geographic URL/title hints order reads; only page evidence can admit a recommendation. */
export function activitySourceLocationScore(
  town: string | null,
  url: string,
  title: string,
): number {
  const parts = town?.split(',').map((part) => part.trim()) ?? [];
  const country = countryName(parts.at(-1) ?? '');
  const region = canadianRegion(parts[1] ?? '');
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return -1;
  }
  const suffix =
    country === 'Canada'
      ? 'ca'
      : country === 'United Kingdom'
        ? 'uk'
        : country === 'United States'
          ? 'us'
          : null;
  const countryScore = suffix && host.endsWith(`.${suffix}`) ? 2 : 0;
  const regionScore = region && host.endsWith(`.${region[0].toLowerCase()}.ca`) ? 2 : 0;
  return countryScore + regionScore + (activityLocationMatches(town, title) ? 2 : 0);
}

function startsWithPlace(text: string, value: string): boolean {
  const region = canadianRegion(value);
  const aliases = region ?? [value];
  return aliases.some((alias) =>
    new RegExp(
      `^[\\s,;|]+${escapeRegex(alias)}(?=$|[^\\p{L}])`,
      alias.length <= 3 ? 'u' : 'iu',
    ).test(text),
  );
}

/** A city name alone cannot establish which country its source belongs to. */
export function activityLocationMatches(town: string | null, text: string): boolean {
  const parts =
    town
      ?.split(',')
      .map((part) => part.trim())
      .filter(Boolean) ?? [];
  const city = parts.shift();
  if (!city || parts.length === 0) return false;
  const region = canadianRegion(parts[0]!);
  const country = countryName(parts.at(-1)!);
  const knownCountry = COUNTRIES.find((names) => names[0] === country);
  if (region && (country === 'Canada' || parts.length === 1)) {
    // A nearby town may differ from the municipality label (e.g. Georgetown / Halton Hills).
    const address = new RegExp(
      `\\b(?:${escapeRegex(region[1])}|${region[0]})[\\s,]+${CANADIAN_POSTAL_CODE}\\b`,
      'u',
    );
    if (address.test(text)) return true;
  }
  const cityPattern = new RegExp(
    `(?<![\\p{L}\\p{N}])${escapeRegex(city)}(?=$|[^\\p{L}\\p{N}])`,
    'giu',
  );
  for (const match of text.matchAll(cityPattern)) {
    // shortcut: require a published address span; sources without one need geographic verification.
    const address = text.slice(match.index + match[0].length, match.index + match[0].length + 160);
    if (!startsWithPlace(address, parts[0]!)) continue;
    if (region && (country === 'Canada' || parts.length === 1)) {
      if (/\bUnited States(?: of America)?\b|\bUSA\b|\bUnited Kingdom\b/i.test(address)) continue;
      const fullProvince = new RegExp(
        `^[\\s,;|]+${escapeRegex(region[1])}(?=$|[^\\p{L}])`,
        'iu',
      ).test(address);
      const canadianAddress = new RegExp(`\\bCanada\\b|\\b${CANADIAN_POSTAL_CODE}\\b`, 'i').test(
        address,
      );
      if (fullProvince || canadianAddress) return true;
      continue;
    }
    if (!knownCountry && country.length <= 3) continue;
    const aliases = knownCountry ?? [country];
    if (
      aliases.some((alias) =>
        new RegExp(
          `(?<![\\p{L}])${escapeRegex(alias)}(?=$|[^\\p{L}])`,
          alias.length <= 3 ? 'u' : 'iu',
        ).test(address),
      )
    )
      return true;
  }
  return false;
}
