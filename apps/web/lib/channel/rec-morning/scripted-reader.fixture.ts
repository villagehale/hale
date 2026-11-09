import type { RecMorningReader } from './read';

/**
 * VIL-545 · the test stand-in for the rec-morning read, installed for every test by
 * vitest.setup.ts. It reads every text as answered, so a suite that reaches the lane
 * exercises the lane's words. What a text MEANS is the model's, pinned by the
 * rec-morning-read eval; a test about the read's outcome hands its own reader. It is a
 * fixture, never imported by production code.
 */
export const scriptedRecMorningReader: RecMorningReader = async () => 'answers';
