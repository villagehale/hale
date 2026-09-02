import { describe, expect, it } from 'vitest';
import { looksLikeJoinRequest } from './parse';

/**
 * The one sentence that mints a co-parent link. Anchored at BOTH ends for the reason
 * VIL-260 spells out on the caregiver command: "add" is the verb parents use about
 * their own calendar far more often than about a person, and a prefix match swallows
 * exactly the sentences the conversational layer exists to answer.
 */
describe('looksLikeJoinRequest', () => {
  it('reads the ways a parent actually asks', () => {
    for (const body of [
      'add my partner',
      'Add my partner.',
      'invite my husband',
      'add my wife',
      'ADD MY SPOUSE',
      'add my co-parent',
      'invite my coparent',
      '  add my partner  ',
      'add dad',
      'invite mom',
    ]) {
      expect(looksLikeJoinRequest(body), `${body} should mint a link`).toBe(true);
    }
  });

  it('leaves an ordinary sentence that merely starts with "add" alone', () => {
    for (const body of [
      "add my partner's dentist appointment",
      'add my partner to the pickup list on Thursday',
      'can you add my husband later',
      'add library story time Saturday 10am',
      'add grandma 647-555-0199 as grandparent',
    ]) {
      expect(looksLikeJoinRequest(body), `${body} is conversation, not a command`).toBe(false);
    }
  });

  /**
   * "my dad" is the PARENT's own father — a grandparent, a different scope entirely.
   * "dad" with no possessive is the children's other parent. The possessive is the
   * whole difference, so it is tested as a pair rather than left to a reader to notice.
   */
  it('does not read "my dad" as the co-parent', () => {
    expect(looksLikeJoinRequest('add dad')).toBe(true);
    expect(looksLikeJoinRequest('add my dad')).toBe(false);
    expect(looksLikeJoinRequest('add my mom')).toBe(false);
  });
});
