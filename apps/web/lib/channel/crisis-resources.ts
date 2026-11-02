/**
 * The crisis lines Hale may hand a model, as facts to weave in. Not a script.
 *
 * Hale serves Canada and the US. The line is the one for that region, never one
 * guessed from the language of the text (a French text is not France). Official
 * lines, checked 2026-11-02:
 * - Canada: 9-8-8 Suicide Crisis Helpline, call or text 988, any time, English
 *   or French. Emergency is 911.
 * - United States: 988 Suicide & Crisis Lifeline, call or text 988, any time.
 *   Emergency is 911.
 * No other number belongs here. The model writes the message. If it cannot,
 * the caller sends nothing.
 */

export type CrisisRegion = 'CA' | 'US';

export interface CrisisResourceFacts {
  readonly region: 'Canada' | 'United States';
  readonly crisisLine: string;
  readonly emergency: string;
}

const CANADA: CrisisResourceFacts = {
  region: 'Canada',
  crisisLine: '9-8-8 Suicide Crisis Helpline: call or text 988, any time, in English or French',
  emergency: '911',
};

const UNITED_STATES: CrisisResourceFacts = {
  region: 'United States',
  crisisLine: '988 Suicide & Crisis Lifeline: call or text 988, any time',
  emergency: '911',
};

/** The facts for a known region, or null when Hale does not know it. */
export function crisisFactsForRegion(
  region: CrisisRegion | null | undefined,
): CrisisResourceFacts | null {
  if (region === 'CA') return CANADA;
  if (region === 'US') return UNITED_STATES;
  return null;
}
