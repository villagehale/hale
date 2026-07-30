import { describe, expect, it } from 'vitest';
import { matchKeyword } from './keywords';

describe('matchKeyword', () => {
  it('matches every CASL stop word regardless of case or surrounding punctuation', () => {
    for (const raw of ['STOP', 'stop', ' Stop. ', 'UNSUBSCRIBE', 'end', 'Quit!', 'cancel']) {
      expect(matchKeyword(raw)).toBe('stop');
    }
  });

  it('matches the help and start words', () => {
    expect(matchKeyword('HELP')).toBe('help');
    expect(matchKeyword('info')).toBe('help');
    expect(matchKeyword('Start')).toBe('start');
  });

  it('does NOT treat a sentence containing a keyword as the keyword', () => {
    // The whole reason matching is exact: these are families still talking to us.
    expect(matchKeyword('please stop sending me the swim times')).toBeNull();
    expect(matchKeyword('can you help me find a daycare')).toBeNull();
    expect(matchKeyword('we start school next week')).toBeNull();
    expect(matchKeyword('cancel my daughter’s class?')).toBeNull();
  });

  it('returns null for ordinary intake answers', () => {
    expect(matchKeyword('Maya is 4 and Leo is 1, M5V 2T6')).toBeNull();
    expect(matchKeyword('')).toBeNull();
  });
});
