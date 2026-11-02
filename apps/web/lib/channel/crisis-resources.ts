/**
 * The crisis lines Hale may hand a model, as facts to weave in. Not a script.
 *
 * Hale serves Canada and the US. A known region gets that country's line.
 * An unknown region gets both lines. The language of the text never picks one
 * (a French text is not France, and it is not "Canada only" either). Official
 * lines, checked 2026-11-02:
 * - Canada: 9-8-8 Suicide Crisis Helpline, call or text 988, any time, English
 *   or French. Emergency is 911.
 * - United States: 988 Suicide & Crisis Lifeline, call or text 988, any time.
 *   Emergency is 911.
 * No other number belongs here. The model writes the message. If it cannot,
 * the caller sends nothing.
 */

export type CrisisRegion = 'CA' | 'US';

const CANADA_LINE =
  '9-8-8 Suicide Crisis Helpline: call or text 988, any time, in English or French';
const US_LINE = '988 Suicide & Crisis Lifeline: call or text 988, any time';

export interface KnownRegionFacts {
  readonly region: 'Canada' | 'United States';
  readonly crisisLine: string;
  readonly emergency: '911';
}

/** Both lines, because Hale does not know which country this parent is in. */
export interface UnknownRegionFacts {
  readonly region: null;
  readonly canadaCrisisLine: string;
  readonly usCrisisLine: string;
  readonly emergency: '911';
}

export type CrisisFacts = KnownRegionFacts | UnknownRegionFacts;

const CANADA: KnownRegionFacts = {
  region: 'Canada',
  crisisLine: CANADA_LINE,
  emergency: '911',
};

const UNITED_STATES: KnownRegionFacts = {
  region: 'United States',
  crisisLine: US_LINE,
  emergency: '911',
};

const UNKNOWN: UnknownRegionFacts = {
  region: null,
  canadaCrisisLine: CANADA_LINE,
  usCrisisLine: US_LINE,
  emergency: '911',
};

/**
 * The facts for a known region, or both lines plus 911 when Hale does not
 * know it. Never null: an unknown region is not a reason to withhold a number.
 */
export function crisisFactsForRegion(region: CrisisRegion): KnownRegionFacts;
export function crisisFactsForRegion(region: null | undefined): UnknownRegionFacts;
export function crisisFactsForRegion(region: CrisisRegion | null | undefined): CrisisFacts;
export function crisisFactsForRegion(region: CrisisRegion | null | undefined): CrisisFacts {
  if (region === 'CA') return CANADA;
  if (region === 'US') return UNITED_STATES;
  return UNKNOWN;
}
