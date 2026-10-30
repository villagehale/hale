import { describe, expect, it } from 'vitest';
import {
  createSharedGroupReader,
  parseSharedGroupReading,
  reactionAsVote,
  sharedGroupUserMessage,
} from './shared-group-reading';

describe('shared group reading', () => {
  it('accepts a high-confidence state change and drops a low-confidence one', () => {
    expect(
      parseSharedGroupReading({
        intent: 'stop_me',
        role: 'unclear',
        familyLabel: null,
        kidName: null,
        confidence: 'high',
      }).intent,
    ).toBe('stop_me');
    expect(
      parseSharedGroupReading({
        intent: 'stop_me',
        role: 'unclear',
        familyLabel: null,
        kidName: null,
        confidence: 'low',
      }).intent,
    ).toBe('unclear');
  });

  it('a parent string is not a reading — only the model object is', () => {
    expect(parseSharedGroupReading('stop').intent).toBe('unclear');
    expect(parseSharedGroupReading({ intent: 'chatter' }).intent).toBe('unclear');
    expect(typeof createSharedGroupReader).toBe('function');
  });

  it('reads hearts and thumbs as votes, and never invents a vote from a laugh', () => {
    expect(reactionAsVote('love')).toBe('yes');
    expect(reactionAsVote('like')).toBe('yes');
    expect(reactionAsVote('emphasize')).toBe('yes');
    expect(reactionAsVote('dislike')).toBe('no');
    expect(reactionAsVote('laugh')).toBeNull();
    expect(reactionAsVote(null)).toBeNull();
  });

  it('hands the eval the same payload shape the live reader sends', () => {
    const payload = JSON.parse(
      sharedGroupUserMessage({
        text: 'leave me out of this one',
        reaction: null,
        language: 'en',
        people: [{ firstName: 'Jordan', knownCustomer: true, familyLinked: true }],
        recent: [{ from: 'hale', text: 'who is in for Saturday' }],
      }),
    );
    expect(payload.text).toBe('leave me out of this one');
    expect(payload.people).toHaveLength(1);
  });
});
