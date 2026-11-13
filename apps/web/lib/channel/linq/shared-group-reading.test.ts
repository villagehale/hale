import { describe, expect, it } from 'vitest';
import {
  createSharedGroupReader,
  parseSharedGroupReading,
  reactionAsVote,
  sharedGroupReadingCommonTimeJsonSchema,
  sharedGroupReadingJsonSchema,
  sharedGroupUserMessage,
} from './shared-group-reading';

describe('shared group reading', () => {
  it('the recorded reader schema does not ask for a calendar withdrawal', () => {
    expect(sharedGroupReadingJsonSchema.properties.intent.enum).not.toContain('withdraw_calendar');
    expect(sharedGroupReadingCommonTimeJsonSchema.properties.intent.enum).toContain(
      'withdraw_calendar',
    );
  });

  it('a calendar-only withdrawal is a high-confidence state change, and not a stop', () => {
    expect(
      parseSharedGroupReading({
        intent: 'withdraw_calendar',
        role: 'unclear',
        familyLabel: null,
        kidNames: [],
        confidence: 'high',
      }).intent,
    ).toBe('withdraw_calendar');
    expect(
      parseSharedGroupReading({
        intent: 'withdraw_calendar',
        role: 'unclear',
        familyLabel: null,
        kidNames: [],
        confidence: 'low',
      }).intent,
    ).toBe('unclear');
  });

  it('accepts a high-confidence state change and drops a low-confidence one', () => {
    expect(
      parseSharedGroupReading({
        intent: 'stop_me',
        role: 'unclear',
        familyLabel: null,
        kidNames: [],
        confidence: 'high',
      }).intent,
    ).toBe('stop_me');
    expect(
      parseSharedGroupReading({
        intent: 'stop_me',
        role: 'unclear',
        familyLabel: null,
        kidNames: [],
        confidence: 'low',
      }).intent,
    ).toBe('unclear');
  });

  it('keeps every child a who-I-am names, trimmed and once each, and the first as kidName', () => {
    const read = parseSharedGroupReading({
      intent: 'who_i_am',
      role: 'parent',
      familyLabel: null,
      kidNames: [' Mia ', 'Leo', '', 'Mia'],
      confidence: 'high',
    });
    expect(read.kidNames).toEqual(['Mia', 'Leo']);
    expect(read.kidName).toBe('Mia');
    const none = parseSharedGroupReading({
      intent: 'who_i_am',
      role: 'parent',
      familyLabel: null,
      kidNames: [],
      confidence: 'high',
    });
    expect([none.intent, none.kidName, none.kidNames]).toEqual(['who_i_am', null, []]);
  });

  it('a reading that names more children than a person has, or a name past bounds, is unclear', () => {
    const base = { intent: 'who_i_am', role: 'parent', familyLabel: null, confidence: 'high' };
    const many = Array.from({ length: 11 }, (_, i) => `Kid${i}`);
    expect(parseSharedGroupReading({ ...base, kidNames: many }).intent).toBe('unclear');
    expect(parseSharedGroupReading({ ...base, kidNames: ['x'.repeat(101)] }).intent).toBe(
      'unclear',
    );
    // The old single-name field is no longer the contract.
    expect(parseSharedGroupReading({ ...base, kidName: 'Mia' }).intent).toBe('unclear');
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
      kidNames: [],
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
      kidNames: [],
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

  it('reads a pick only as one of the times Hale offered, to the instant', () => {
    const offered = ['2026-10-31T14:00:00.000Z', '2026-11-01T15:00:00.000Z'];
    const pick = (picked: unknown) =>
      parseSharedGroupReading(
        {
          intent: 'pick_time',
          role: 'unclear',
          familyLabel: null,
          kidNames: [],
          confidence: 'high',
          ruledOut: [],
          picked,
          planTitle: '  Zoo trip ',
        },
        offered,
      );
    const read = pick('2026-10-31T10:00:00-04:00');
    expect(read.intent).toBe('pick_time');
    expect(read.picked).toEqual(new Date('2026-10-31T14:00:00.000Z'));
    expect(read.planTitle).toBe('Zoo trip');
    // A time Hale never offered, a missing pick, or no offer at all is not a pick.
    expect(pick('2026-10-31T15:00:00.000Z').intent).toBe('unclear');
    expect(pick(null).intent).toBe('unclear');
    // A pick places a plan on calendars: a low-confidence one is no pick.
    expect(
      parseSharedGroupReading(
        {
          intent: 'pick_time',
          role: 'unclear',
          familyLabel: null,
          kidNames: [],
          confidence: 'low',
          picked: offered[0],
        },
        offered,
      ).intent,
    ).toBe('unclear');
    expect(
      parseSharedGroupReading({
        intent: 'pick_time',
        role: 'unclear',
        familyLabel: null,
        kidNames: [],
        confidence: 'high',
        picked: offered[0],
      }).intent,
    ).toBe('unclear');
  });

  it('keeps a plan title only on a find-time or a pick, and never a pick on another intent', () => {
    const base = { role: 'unclear', familyLabel: null, kidNames: [], confidence: 'high' };
    const find = parseSharedGroupReading({ ...base, intent: 'find_time', planTitle: 'Zoo' });
    expect(find.planTitle).toBe('Zoo');
    const question = parseSharedGroupReading(
      { ...base, intent: 'question', planTitle: 'Zoo', picked: '2026-10-31T14:00:00.000Z' },
      ['2026-10-31T14:00:00.000Z'],
    );
    expect(question.planTitle).toBeNull();
    expect(question.picked).toBeNull();
  });

  it('shows the reader the times Hale offered only when there are some', () => {
    const base = { text: 'Saturday works', reaction: null, language: 'en', people: [], recent: [] };
    expect(JSON.parse(sharedGroupUserMessage(base)).offered).toBeUndefined();
    const offered = [{ start: '2026-10-31T14:00:00.000Z', local: 'Sat Oct 31 10:00' }];
    expect(JSON.parse(sharedGroupUserMessage({ ...base, offered })).offered).toEqual(offered);
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
