/**
 * The crisis lines Hale may hand a model, as facts to weave in. Not a script.
 *
 * Hale serves Canada and the US. A physical emergency is 911 only. 988 (Canada's
 * 9-8-8 line, or the US 988 line) is added only for a mental-health signal.
 * A known region gets that country's 988 line. An unknown region gets both 988
 * lines, plus 911. The language of the text never picks one (a French text is
 * not France, and it is not "Canada only" either). Official lines, checked
 * 2026-11-02:
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

/** A physical emergency. 911 only — no 988 line. */
export interface EmergencyFacts {
  readonly emergency: '911';
}

export interface KnownMentalFacts {
  readonly region: 'Canada' | 'United States';
  readonly crisisLine: string;
  readonly emergency: '911';
}

/** Both 988 lines plus 911, because Hale does not know which country this parent is in. */
export interface UnknownMentalFacts {
  readonly region: null;
  readonly canadaCrisisLine: string;
  readonly usCrisisLine: string;
  readonly emergency: '911';
}

export type CrisisSignal = 'emergency' | 'mental';

export type CrisisFacts = EmergencyFacts | KnownMentalFacts | UnknownMentalFacts;

const EMERGENCY: EmergencyFacts = { emergency: '911' };

const CANADA_MENTAL: KnownMentalFacts = {
  region: 'Canada',
  crisisLine: CANADA_LINE,
  emergency: '911',
};

const US_MENTAL: KnownMentalFacts = {
  region: 'United States',
  crisisLine: US_LINE,
  emergency: '911',
};

const UNKNOWN_MENTAL: UnknownMentalFacts = {
  region: null,
  canadaCrisisLine: CANADA_LINE,
  usCrisisLine: US_LINE,
  emergency: '911',
};

/**
 * Facts for a signal. Emergency is 911 only, in every region. Mental keeps the
 * 988 line for a known region (and 911), or both 988 lines plus 911 when the
 * region is unknown. Never null, and never chosen from the parent's language.
 */
export function crisisFactsForRegion(
  region: CrisisRegion | null | undefined,
  signal: 'emergency',
): EmergencyFacts;
export function crisisFactsForRegion(region: CrisisRegion, signal: 'mental'): KnownMentalFacts;
export function crisisFactsForRegion(
  region: null | undefined,
  signal: 'mental',
): UnknownMentalFacts;
export function crisisFactsForRegion(
  region: CrisisRegion | null | undefined,
  signal: CrisisSignal,
): CrisisFacts;
export function crisisFactsForRegion(
  region: CrisisRegion | null | undefined,
  signal: CrisisSignal,
): CrisisFacts {
  if (signal === 'emergency') return EMERGENCY;
  if (region === 'CA') return CANADA_MENTAL;
  if (region === 'US') return US_MENTAL;
  return UNKNOWN_MENTAL;
}
