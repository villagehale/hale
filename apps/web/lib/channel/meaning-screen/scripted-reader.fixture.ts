import type { MeaningScreen, MeaningScreenInput, MeaningScreenReading } from './read';

/**
 * Test stand-in. Production has no word list. Suites that light the sweep
 * inject a reader; this one is a blank miss so a forgotten injection fails
 * closed instead of calling Anthropic.
 */

const BLANK: MeaningScreenReading = {
  hit: false,
  violations: [],
  kind: 'none',
  intent: 'none',
  outcome: 'none',
  decision: 'none',
  action: 'none',
  provider: 'none',
  activity: '',
  kid: '',
  day: '',
  time: '',
  name: '',
  position: null,
};

export function blankMeaningReading(
  over: Partial<MeaningScreenReading> = {},
): MeaningScreenReading {
  return { ...BLANK, ...over };
}

export function scriptedMeaningScreen(
  read: (input: MeaningScreenInput) => MeaningScreenReading | null,
): MeaningScreen {
  return {
    read: async (input) => read(input),
  };
}

export const unreadMeaningScreen: MeaningScreen = {
  read: async () => null,
};
