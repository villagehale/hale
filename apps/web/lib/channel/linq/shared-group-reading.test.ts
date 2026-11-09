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

  it('reads a find-time ask with the spans the chat ruled out, dropping any that do not parse', () => {
    const read = parseSharedGroupReading({
      intent: 'find_time',
      role: 'unclear',
      familyLabel: null,
      kidName: null,
      confidence: 'high',
      ruledOut: [
        { start: '2026-10-31T08:00:00-04:00', end: '2026-10-31T12:00:00-04:00' },
        { start: 'saturday', end: '2026-10-31T12:00:00-04:00' },
        { start: '2026-10-31T12:00:00-04:00', end: '2026-10-31T08:00:00-04:00' },
      ],
    });
    expect(read.intent).toBe('find_time');
    expect(read.ruledOut).toEqual([
      { start: new Date('2026-10-31T12:00:00Z'), end: new Date('2026-10-31T16:00:00Z') },
    ]);
  });

  it('a span on any other intent is not a constraint', () => {
    const read = parseSharedGroupReading({
      intent: 'question',
      role: 'unclear',
      familyLabel: null,
      kidName: null,
      confidence: 'high',
      ruledOut: [{ start: '2026-10-31T08:00:00-04:00', end: '2026-10-31T12:00:00-04:00' }],
    });
    expect(read.intent).toBe('question');
    expect(read.ruledOut).toEqual([]);
  });

  it('gives the reader the clock only when one is known', () => {
    const base = {
      text: 'when can we all do the zoo?',
      reaction: null,
      language: 'en',
      people: [],
      recent: [],
    };
    expect(JSON.parse(sharedGroupUserMessage(base)).clock).toBeUndefined();
    const clock = { now: '2026-10-28T11:00:00-04:00', timeZone: 'America/New_York' };
    expect(JSON.parse(sharedGroupUserMessage({ ...base, clock })).clock).toEqual(clock);
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
