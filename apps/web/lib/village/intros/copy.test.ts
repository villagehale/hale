import { FAMILY_STAGES } from '@hale/types';
import { describe, expect, it } from 'vitest';
import { smsEncoding, smsSegments } from '~/lib/channel/sms-segments';
import { stageWord } from './copy';

/**
 * copy.ts now holds only the stage noun handed to the composers as a fact. The fixed
 * acknowledgements and soft close were removed in VIL-450 (said-line `intro_reply`).
 */

describe('stageWord', () => {
  it('has a stage word for every stage, and none of them is the raw stage key', () => {
    // 'preschool' and 'teenager' are labels, not nouns a sentence can hold.
    expect(stageWord('preschool')).toBe('preschooler');
    expect(stageWord('teenager')).toBe('teen');
    expect(stageWord('newborn')).toBe('baby');
    expect(stageWord('child')).toBe('kid');
    expect(stageWord('toddler')).toBe('toddler');
  });
});

describe('every stage word', () => {
  it.each(FAMILY_STAGES)('%s stays in the GSM-7 alphabet and one segment', (stage) => {
    expect(smsEncoding(stageWord(stage))).toBe('gsm7');
    expect(smsSegments(stageWord(stage))).toBe(1);
  });
});
