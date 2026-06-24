import { describe, expect, it } from 'vitest';
import { TOPICS, tagTopic } from './topic';

/**
 * A turn is tagged with a coarse topic so the family's ONE conversation reads as a
 * timeline filterable by topic. Keyword-based (no LLM) — a miss is null (untagged),
 * which is a valid state, not an error. Asserts the mapping is meaningful and the
 * topic set is the closed list the filter UI offers.
 */

describe('tagTopic', () => {
  it('tags sleep questions as sleep', () => {
    expect(tagTopic('how many naps should a 6 month old take?')).toBe('sleep');
    expect(tagTopic('she keeps waking up at 3am, is that normal?')).toBe('sleep');
  });

  it('tags feeding questions as feeding', () => {
    expect(tagTopic('when do we start solids?')).toBe('feeding');
  });

  it('tags health/appointment questions as health', () => {
    expect(tagTopic('should I book a check-up with the pediatrician?')).toBe('health');
  });

  it('returns null when no topic matches', () => {
    expect(tagTopic('what is good near us this weekend?')).toBe('activities');
    expect(tagTopic('hello there')).toBeNull();
  });

  it('exposes a closed topic set for the filter UI', () => {
    expect(TOPICS).toContain('sleep');
    expect(TOPICS).toContain('feeding');
    expect(TOPICS).toContain('health');
  });
});
