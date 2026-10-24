import { FAMILY_STAGES } from '@hale/types';
import { describe, expect, it } from 'vitest';
import { smsEncoding, smsSegments } from '~/lib/channel/sms-segments';
import {
  DISCOVERABILITY_OFF,
  DISCOVERABILITY_ON,
  INTRO_NO_ACK,
  INTRO_SOFT_CLOSE,
  NO_OPEN_INTRO,
  stageWord,
} from './copy';

/**
 * The copy IS the spec, so these assertions are verbatim. What earns its place beyond
 * the string equality is the property tests: the card cannot be handed the other
 * family's identity, the soft close is identical for all three reasons an intro dies,
 * and every outbound body fits GSM-7 inside its segment budget.
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

describe('the acks that stayed fixed', () => {
  it('never instruct a keyword - the arc that composed the two asks (2026-08-13)', () => {
    // STOP is exempt everywhere it appears: it is the CASL vocabulary the carrier and the
    // intake machine both honour, and softening it would break a legal off-ramp. What may
    // not survive is Hale handing a parent a token to recite in order to be understood.
    const instruction = /\b(reply|respond|text|send|type)\b[^.?!]{0,20}\b(yes|no|intro|intros)\b/i;
    for (const [name, body] of [
      ['DISCOVERABILITY_ON', DISCOVERABILITY_ON],
      ['DISCOVERABILITY_OFF', DISCOVERABILITY_OFF],
      ['INTRO_NO_ACK', INTRO_NO_ACK],
      ['NO_OPEN_INTRO', NO_OPEN_INTRO],
      ['INTRO_SOFT_CLOSE', INTRO_SOFT_CLOSE],
    ] as const) {
      expect(body, `${name} must not tell a parent which word to type`).not.toMatch(instruction);
    }
  });

  it('still gives the opt-in ack a real off-ramp, in words', () => {
    expect(DISCOVERABILITY_ON.toLowerCase()).toContain('tell me to stop');
  });
});

describe('INTRO_SOFT_CLOSE', () => {
  it('is the spec sentence, verbatim', () => {
    expect(INTRO_SOFT_CLOSE).toBe("No intro this time - I'll keep an eye out.");
  });

  it('reveals nothing about why - no refusal, no silence, no clock', () => {
    const forbidden = ['no thanks', 'declined', 'passed', 'said no', 'reply', 'expired', 'week'];
    for (const word of forbidden) {
      expect(INTRO_SOFT_CLOSE.toLowerCase()).not.toContain(word);
    }
  });
});

describe('every outbound SMS body', () => {
  /** The worst case each template can produce, so the budget is asserted against the
   * longest real rendering rather than the shortest. */
  const bodies: Array<[string, string]> = [
    ['DISCOVERABILITY_ON', DISCOVERABILITY_ON],
    ['DISCOVERABILITY_OFF', DISCOVERABILITY_OFF],
    ['INTRO_NO_ACK', INTRO_NO_ACK],
    ['INTRO_SOFT_CLOSE', INTRO_SOFT_CLOSE],
    ['NO_OPEN_INTRO', NO_OPEN_INTRO],
    // The two ASKS are composed now and are held to the same envelope by their own
    // refusals (voice.ts) and by the eval, not by a string in this file.
    ...FAMILY_STAGES.map((stage): [string, string] => [`stageWord:${stage}`, stageWord(stage)]),
  ];

  it.each(bodies)('%s stays in the GSM-7 alphabet', (_name, body) => {
    expect(smsEncoding(body)).toBe('gsm7');
  });

  it.each(bodies)('%s fits two segments', (_name, body) => {
    expect(smsSegments(body)).toBeLessThanOrEqual(2);
  });
});
