import { describe, expect, it } from 'vitest';
import {
  type BusyBlock,
  classifyKidCalendarItem,
  kidMailboxSubject,
  planHouseholdNotices,
} from './household-calendar';

/**
 * Kid vs not-kid is a function, not a prompt. A non-kid title must be unable
 * to appear in a group notice even when the block still carries one.
 */

const PARENT_A = 'parent-a';
const PARENT_B = 'parent-b';
const NOW = new Date('2026-09-24T18:00:00.000Z');
const ZONE = 'America/Toronto';

function block(over: Partial<BusyBlock> & Pick<BusyBlock, 'eventId' | 'userId'>): BusyBlock {
  return {
    integrationId: `int-${over.userId}`,
    start: new Date('2026-09-25T19:00:00.000Z'),
    end: new Date('2026-09-25T20:00:00.000Z'),
    allDay: false,
    kidRelated: false,
    title: null,
    status: 'confirmed',
    announced: false,
    followupSent: false,
    recurringEventId: null,
    ...over,
  };
}

function notices(blocks: BusyBlock[]) {
  return planHouseholdNotices({
    blocks,
    parentUserIds: [PARENT_A, PARENT_B],
    now: NOW,
    timeZone: ZONE,
    language: 'en',
  });
}

describe('classifyKidCalendarItem', () => {
  it('shares a class, a child name, and a gymnastics session', () => {
    expect(classifyKidCalendarItem({ title: 'Maya gymnastics', childNames: ['Maya'] })).toBe(true);
    expect(classifyKidCalendarItem({ title: 'swim class', childNames: [] })).toBe(true);
    expect(classifyKidCalendarItem({ title: 'school pickup', childNames: [] })).toBe(true);
  });

  it('does not treat a parent meeting or the word classic as a class', () => {
    expect(
      classifyKidCalendarItem({ title: 'Quarterly budget review', childNames: ['Maya'] }),
    ).toBe(false);
    expect(classifyKidCalendarItem({ title: 'classic rock night', childNames: [] })).toBe(false);
    expect(classifyKidCalendarItem({ title: '', childNames: ['Maya'] })).toBe(false);
  });
});

describe('kidMailboxSubject', () => {
  it('keeps a kid subject and drops an address or a private subject', () => {
    expect(kidMailboxSubject({ subject: 'Gymnastics registration', childNames: [] })).toBe(
      'Gymnastics registration',
    );
    expect(kidMailboxSubject({ subject: 'Maya <maya@school.test>', childNames: ['Maya'] })).toBe(
      null,
    );
    expect(kidMailboxSubject({ subject: 'Quarterly budget review', childNames: ['Maya'] })).toBe(
      null,
    );
  });
});

describe('planHouseholdNotices', () => {
  it('tells the other parent about a kid event and never the private title', () => {
    const planned = notices([
      block({
        eventId: 'gym',
        userId: PARENT_A,
        kidRelated: true,
        title: 'Maya gymnastics',
      }),
      block({
        eventId: 'budget',
        userId: PARENT_B,
        kidRelated: false,
        title: 'Quarterly budget review',
      }),
    ]);
    const kid = planned.find((notice) => notice.kind === 'kid_event');
    const conflict = planned.find((notice) => notice.kind === 'conflict');
    expect(kid?.text).toContain('Maya gymnastics');
    expect(kid?.recipientUserId).toBe(PARENT_B);
    expect(conflict?.text).toContain('Maya gymnastics');
    expect(conflict?.text).toContain('I can find the page.');
    expect(conflict?.text).not.toMatch(/I(?:'ll| will) book/i);
    for (const notice of planned) {
      expect(notice.text).not.toContain('Quarterly');
      expect(notice.text).not.toContain('budget');
    }
  });

  it('names both kid titles when both parents are booked, and a handoff across weeks', () => {
    const both = notices([
      block({
        eventId: 'gym-a',
        userId: PARENT_A,
        kidRelated: true,
        title: 'Maya gymnastics',
      }),
      block({
        eventId: 'gym-b',
        userId: PARENT_B,
        kidRelated: true,
        title: 'Swim class',
      }),
    ]);
    const booked = both.find((notice) => notice.kind === 'both_booked');
    expect(booked?.text).toContain('Maya gymnastics');
    expect(booked?.text).toContain('Swim class');

    const handoff = notices([
      block({
        eventId: 'this-week',
        userId: PARENT_A,
        kidRelated: true,
        title: 'Maya gymnastics',
        announced: true,
        start: new Date('2026-09-25T19:00:00.000Z'),
        end: new Date('2026-09-25T20:00:00.000Z'),
      }),
      block({
        eventId: 'next-week',
        userId: PARENT_B,
        kidRelated: true,
        title: 'Maya gymnastics',
        announced: true,
        start: new Date('2026-10-02T19:00:00.000Z'),
        end: new Date('2026-10-02T20:00:00.000Z'),
      }),
    ]);
    expect(handoff.find((notice) => notice.kind === 'handoff')?.text).toContain('Handoff:');
    expect(handoff.find((notice) => notice.kind === 'handoff')?.text).toContain('Maya gymnastics');
  });

  it('asks how it went once', () => {
    const planned = notices([
      block({
        eventId: 'done-1',
        userId: PARENT_A,
        kidRelated: true,
        title: 'Maya gymnastics',
        announced: true,
        start: new Date('2026-09-24T15:00:00.000Z'),
        end: new Date('2026-09-24T16:00:00.000Z'),
      }),
      block({
        eventId: 'done-2',
        userId: PARENT_B,
        kidRelated: true,
        title: 'Swim class',
        announced: true,
        start: new Date('2026-09-24T15:00:00.000Z'),
        end: new Date('2026-09-24T16:30:00.000Z'),
      }),
    ]);
    const followups = planned.filter((notice) => notice.kind === 'followup');
    expect(followups).toHaveLength(1);
    expect(followups[0]?.text).toBe('How did Maya gymnastics go?');
  });
});
