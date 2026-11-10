import type { RecMorningTopicPicker } from './topic';

/**
 * VIL-545 leftover · the test stand-in for the rec-morning topic picker, installed
 * for every test by vitest.setup.ts. Flag off, it is never called. A test that
 * turns the flag on hands its own picker. It is a fixture, never imported by
 * production code.
 */
export const scriptedRecMorningTopicPicker: RecMorningTopicPicker = async () => {
  throw new Error('rec-morning topic picker: test must hand its own picker when the flag is on');
};
