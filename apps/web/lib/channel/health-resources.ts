/**
 * The health lines Hale may hand a model, as facts to weave in. Not a script.
 *
 * 811 is the nurse line in Ontario (Health811) and British Columbia (HealthLink
 * BC). A known region gets that line. An unknown region gets both lines. The
 * language of the text never picks one. 911 is the emergency number in both,
 * and it is always a fact. Official lines, checked 2026-11-02:
 * - Ontario: Health811, call 811, any time.
 * - British Columbia: HealthLink BC, call 8-1-1, any time.
 * - Emergency: 911.
 * No other number belongs here. The model writes the message. If it cannot,
 * the caller sends nothing.
 */

export type HealthRegion = 'ON' | 'BC';

const ONTARIO_LINE = 'Health811 (Ontario), call 811, any time';
const BC_LINE = 'HealthLink BC, call 8-1-1, any time';

export interface HealthFacts {
  readonly region: 'Ontario' | 'British Columbia' | null;
  /** One line when the region is known. Both lines when it is not. */
  readonly healthLine: string;
  readonly emergency: '911';
}

const ONTARIO: HealthFacts = {
  region: 'Ontario',
  healthLine: ONTARIO_LINE,
  emergency: '911',
};

const BRITISH_COLUMBIA: HealthFacts = {
  region: 'British Columbia',
  healthLine: BC_LINE,
  emergency: '911',
};

/** Both lines, because Hale does not know which of the two this parent is in. */
const UNKNOWN: HealthFacts = {
  region: null,
  healthLine: `${ONTARIO_LINE}; ${BC_LINE}`,
  emergency: '911',
};

/**
 * The facts for Ontario or British Columbia, or both lines plus 911 when Hale
 * does not know which. Never null: an unknown region is not a reason to
 * withhold a number.
 */
export function healthFactsForRegion(region: HealthRegion | null | undefined): HealthFacts {
  if (region === 'ON') return ONTARIO;
  if (region === 'BC') return BRITISH_COLUMBIA;
  return UNKNOWN;
}

/** Ontario or British Columbia when a token says so. Anything else is unknown. */
export function healthRegionFromTokens(
  tokens: readonly (string | null | undefined)[],
): HealthRegion | null {
  for (const token of tokens) {
    if (typeof token !== 'string') continue;
    const region = regionFromToken(token);
    if (region) return region;
  }
  return null;
}

/** Province or state on a known place. A city name is not a region. */
export function healthRegionFromPlace(
  place: { provinceOrState?: string | null } | null,
): HealthRegion | null {
  if (!place) return null;
  return healthRegionFromTokens([place.provinceOrState]);
}

function regionFromToken(token: string): HealthRegion | null {
  const folded = token.trim().toLowerCase().replace(/\./g, '');
  if (folded === 'on' || folded === 'ontario') return 'ON';
  if (folded === 'bc' || folded === 'british columbia') return 'BC';
  const postal = token.trim().toUpperCase().replace(/\s+/g, '');
  if (/^[KLMNP]\d[A-Z]/.test(postal)) return 'ON';
  if (/^V\d[A-Z]/.test(postal)) return 'BC';
  return null;
}

/**
 * A required number is present. Dashes and spaces between its digits do not
 * count (`8-1-1` and `9 1 1` are the numbers). A longer digit run is not a
 * match (`647-555-0811` does not contain 811).
 */
export function textHasNumber(text: string, digits: string): boolean {
  if (!/^\d+$/.test(digits)) return text.includes(digits);
  const collapsed = text.replace(/(\d)[\s-]+(?=\d)/g, '$1');
  return new RegExp(`\\b${digits}\\b`).test(collapsed);
}

/** 911 on an emergency. A health worry must also carry 811. */
export function medicalMustInclude(kind: 'health' | 'emergency'): readonly string[] {
  return kind === 'emergency' ? ['911'] : ['811', '911'];
}

export function medicalTextHasRequiredNumbers(kind: 'health' | 'emergency', text: string): boolean {
  return medicalMustInclude(kind).every((digits) => textHasNumber(text, digits));
}
