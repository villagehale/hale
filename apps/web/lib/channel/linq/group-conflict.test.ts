import { describe, expect, it } from 'vitest';
import {
  type ClashPerson,
  type ClashPlan,
  type ClashSourceBlock,
  clashCalendar,
  findGroupClashes,
  groupConflictLineInput,
  groupConflictTextUsable,
} from './group-conflict';

const NOW = new Date('2026-09-25T18:00:00.000Z');
const AT_3 = new Date('2026-09-25T19:00:00.000Z');
const AT_330 = new Date('2026-09-25T19:30:00.000Z');
const AT_4 = new Date('2026-09-25T20:00:00.000Z');

const barton: ClashPerson = { id: 'barton', name: 'Barton', calendar: true };
const sam: ClashPerson = { id: 'sam', name: 'Sam', calendar: true };
const rosa: ClashPerson = { id: 'rosa', name: 'Rosa', calendar: false };

function plan(over: Partial<ClashPlan> & Pick<ClashPlan, 'key' | 'title'>): ClashPlan {
  return { start: AT_3, end: AT_330, holders: [], takerId: null, rows: [], ...over };
}

function block(over: Partial<ClashSourceBlock> & Pick<ClashSourceBlock, 'eventId'>) {
  return {
    integrationId: 'gcal-barton',
    userId: 'barton',
    start: AT_3,
    end: AT_330,
    allDay: false,
    kidRelated: true,
    title: null,
    status: 'confirmed',
    ...over,
  };
}

const noDecision = () => null;

describe('findGroupClashes', () => {
  it('flags two pickups at once on one calendar and suggests the parent free on theirs', () => {
    const [clash, ...rest] = findGroupClashes({
      plans: [
        plan({ key: 'a', title: 'Maya swim pickup', holders: ['barton'] }),
        plan({ key: 'b', title: 'Leo daycare pickup', holders: ['barton'] }),
      ],
      busy: [],
      people: [barton, sam],
      now: NOW,
    });
    expect(rest).toEqual([]);
    expect(clash?.first.key).toBe('a');
    expect(clash && 'plan' in clash.second && clash.second.plan.key).toBe('b');
    expect(clash?.restsOn).toEqual({ a: 'barton', b: 'barton' });
    expect(clash?.suggested).toEqual({ personId: 'sam', planKey: 'b' });
    expect(clash?.couldAsk).toEqual([]);
  });

  it('says nothing when two parents cover the overlap', () => {
    expect(
      findGroupClashes({
        plans: [
          plan({ key: 'a', title: 'Maya recital', holders: ['barton'], end: AT_4 }),
          plan({ key: 'b', title: 'Leo practice', holders: ['sam'] }),
        ],
        busy: [],
        people: [barton, sam],
        now: NOW,
      }),
    ).toEqual([]);
  });

  it('flags a plan whose taker is busy then', () => {
    const [clash] = findGroupClashes({
      plans: [plan({ key: 'a', title: 'Maya recital', takerId: 'barton', end: AT_4 })],
      busy: [{ key: 'busy:1', personId: 'barton', start: AT_330, end: AT_4 }],
      people: [barton, sam],
      now: NOW,
    });
    expect(clash && 'busy' in clash.second && clash.second.busy.personId).toBe('barton');
    expect(clash?.suggested).toEqual({ personId: 'sam', planKey: 'a' });
    expect(clash?.busy).toEqual(['barton']);
  });

  it('never calls someone free from a calendar Hale cannot see', () => {
    const [clash] = findGroupClashes({
      plans: [
        plan({ key: 'a', title: 'Maya swim pickup', holders: ['barton'] }),
        plan({ key: 'b', title: 'Leo daycare pickup', holders: ['barton'] }),
      ],
      busy: [],
      people: [barton, { ...sam, calendar: false }, rosa],
      now: NOW,
    });
    expect(clash?.suggested).toBeNull();
    expect(clash?.alsoFree).toEqual([]);
    expect(clash?.couldAsk).toEqual(['sam', 'rosa']);
  });

  it('does not suggest a parent their calendar shows busy', () => {
    const [clash] = findGroupClashes({
      plans: [
        plan({ key: 'a', title: 'Maya swim pickup', holders: ['barton'] }),
        plan({ key: 'b', title: 'Leo daycare pickup', holders: ['barton'] }),
      ],
      busy: [{ key: 'busy:sam', personId: 'sam', start: AT_3, end: AT_4 }],
      people: [barton, sam, rosa],
      now: NOW,
    });
    expect(clash?.suggested).toBeNull();
    expect(clash?.busy).toEqual(['sam']);
    expect(clash?.couldAsk).toEqual(['rosa']);
  });

  it('respects a stored taker over the calendar a plan sits on', () => {
    const plans = [
      plan({ key: 'a', title: 'Maya swim pickup', holders: ['barton'] }),
      plan({ key: 'b', title: 'Leo daycare pickup', holders: ['barton'], takerId: 'sam' }),
    ];
    expect(findGroupClashes({ plans, busy: [], people: [barton, sam], now: NOW })).toEqual([]);
  });

  it('treats a long kid item as a container, not a clash', () => {
    expect(
      findGroupClashes({
        plans: [
          plan({
            key: 'school',
            title: 'Maya school',
            holders: ['barton'],
            start: new Date('2026-09-25T12:30:00.000Z'),
            end: new Date('2026-09-25T21:00:00.000Z'),
          }),
          plan({ key: 'b', title: 'Leo daycare pickup', holders: ['barton'] }),
        ],
        busy: [],
        people: [barton, sam],
        now: NOW,
      }),
    ).toEqual([]);
  });

  it('keeps one dedupe key for one clash across sweeps, and a new one when a time moves', () => {
    const plans = [
      plan({ key: 'a', title: 'Maya swim pickup', holders: ['barton'] }),
      plan({ key: 'b', title: 'Leo daycare pickup', holders: ['barton'] }),
    ];
    const first = findGroupClashes({ plans, busy: [], people: [barton, sam], now: NOW });
    const later = findGroupClashes({
      plans,
      busy: [],
      people: [barton, sam],
      now: new Date(NOW.getTime() + 15 * 60 * 1000),
    });
    expect(first[0]?.dedupeKey).toMatch(/^linq-group:clash:[0-9a-f]{32}$/);
    expect(later[0]?.dedupeKey).toBe(first[0]?.dedupeKey);
    const moved = findGroupClashes({
      plans: [plans[0] as ClashPlan, { ...(plans[1] as ClashPlan), start: AT_330, end: AT_4 }],
      busy: [],
      people: [barton, sam],
      now: NOW,
    });
    expect(moved).toEqual([]);
    const shifted = findGroupClashes({
      plans: [
        plans[0] as ClashPlan,
        { ...(plans[1] as ClashPlan), start: new Date(AT_3.getTime() + 10 * 60 * 1000) },
      ],
      busy: [],
      people: [barton, sam],
      now: NOW,
    });
    expect(shifted[0]?.dedupeKey).not.toBe(first[0]?.dedupeKey);
  });

  it('names each plan in one clash, and still flags a third plan at the same time', () => {
    const clashes = findGroupClashes({
      plans: [
        plan({ key: 'a', title: 'Maya swim pickup', holders: ['barton'] }),
        plan({ key: 'b', title: 'Leo daycare pickup', holders: ['barton'] }),
        plan({ key: 'c', title: 'Ava piano pickup', holders: ['barton'] }),
      ],
      busy: [],
      people: [barton, sam],
      now: NOW,
    });
    expect(
      clashes.map((clash) => [clash.first.key, 'plan' in clash.second && clash.second.plan.key]),
    ).toEqual([
      ['a', 'b'],
      ['a', 'c'],
    ]);
    expect(new Set(clashes.map((clash) => clash.dedupeKey)).size).toBe(2);
  });

  it('ignores plans already started, and plans past the lookahead', () => {
    expect(
      findGroupClashes({
        plans: [
          plan({ key: 'a', title: 'Maya swim pickup', holders: ['barton'] }),
          plan({ key: 'b', title: 'Leo daycare pickup', holders: ['barton'] }),
        ],
        busy: [],
        people: [barton, sam],
        now: new Date(AT_3.getTime() + 60 * 1000),
      }),
    ).toEqual([]);
  });
});

describe('clashCalendar', () => {
  it('turns a private Hale-held plan into busy time for its taker, and drops its calendar copy', () => {
    const calendar = clashCalendar({
      blocks: [
        block({ eventId: 'swim', title: 'Maya swim pickup' }),
        block({ eventId: 'placed-allergist', title: 'Maya allergist', start: AT_3, end: AT_4 }),
      ],
      events: [
        {
          id: 'allergist',
          title: 'Maya allergist',
          start: AT_3,
          end: AT_4,
          private: true,
          owner: { kind: 'parent', userId: 'barton' },
          placedGoogleEventId: 'placed-allergist',
        },
      ],
      decidedTaker: noDecision,
    });
    expect(calendar.plans.map((row) => row.title)).toEqual(['Maya swim pickup']);
    expect(calendar.busy.map((row) => row.personId)).toEqual(['barton', 'barton']);

    const [clash] = findGroupClashes({ ...calendar, people: [barton, sam], now: NOW });
    expect(clash && 'busy' in clash.second).toBe(true);
    const line = groupConflictLineInput(clash as NonNullable<typeof clash>, {
      people: [barton, sam],
      kids: ['Maya'],
      timeZone: 'America/Toronto',
      language: 'en',
    });
    expect(line.items[1]).toEqual({ kind: 'busy', who: 'Barton' });
    expect(JSON.stringify(line)).not.toMatch(/allergist/i);
    expect(line.suggested).toEqual({ name: 'Sam', takes: 'Maya swim pickup' });
  });

  it('merges a kid item on two calendars into one plan both parents hold', () => {
    const calendar = clashCalendar({
      blocks: [
        block({ eventId: 'swim-b', title: 'Maya swim' }),
        block({
          eventId: 'swim-s',
          integrationId: 'gcal-sam',
          userId: 'sam',
          title: '  maya   SWIM ',
        }),
      ],
      events: [],
      decidedTaker: noDecision,
    });
    expect(calendar.plans).toHaveLength(1);
    expect(calendar.plans[0]?.holders).toEqual(['barton', 'sam']);
    expect(calendar.plans[0]?.rows).toHaveLength(2);
  });

  it('keeps a non-kid block as busy time only, and skips all-day and cancelled items', () => {
    const calendar = clashCalendar({
      blocks: [
        block({ eventId: 'work', kidRelated: false }),
        block({ eventId: 'trip', title: 'Maya camp', allDay: true }),
        block({ eventId: 'gone', title: 'Maya swim', status: 'cancelled' }),
      ],
      events: [
        {
          id: 'no-end',
          title: 'Leo pickup',
          start: AT_3,
          end: null,
          private: false,
          owner: null,
          placedGoogleEventId: null,
        },
      ],
      decidedTaker: noDecision,
    });
    expect(calendar.plans).toEqual([]);
    expect(calendar.busy).toEqual([
      { key: 'busy:gcal-barton:work', personId: 'barton', start: AT_3, end: AT_330 },
    ]);
  });

  it('takes the taker from a duty owner or a decided who-takes, never from words', () => {
    const calendar = clashCalendar({
      blocks: [block({ eventId: 'swim', title: 'Maya swim pickup' })],
      events: [
        {
          id: 'piano',
          title: 'Leo piano pickup',
          start: AT_3,
          end: AT_330,
          private: false,
          owner: { kind: 'named', label: 'Grandma' },
          placedGoogleEventId: null,
        },
      ],
      decidedTaker: (startIso, titleNorm) =>
        startIso === AT_3.toISOString() && titleNorm === 'maya swim pickup' ? 'sam' : null,
    });
    expect(calendar.plans.map((row) => [row.title, row.takerId])).toEqual([
      ['Leo piano pickup', 'named:Grandma'],
      ['Maya swim pickup', 'sam'],
    ]);
    expect(calendar.named).toEqual([{ id: 'named:Grandma', name: 'Grandma', calendar: false }]);
  });
});

describe('groupConflictLineInput', () => {
  it('gives the model local day and time, names, and nothing from a hidden calendar', () => {
    const [clash] = findGroupClashes({
      plans: [
        plan({ key: 'a', title: 'Maya swim pickup', holders: ['barton'] }),
        plan({ key: 'b', title: 'Leo daycare pickup', holders: ['barton'] }),
      ],
      busy: [],
      people: [barton, sam, rosa],
      now: NOW,
    });
    const line = groupConflictLineInput(clash as NonNullable<typeof clash>, {
      people: [barton, sam, rosa],
      kids: ['Maya', 'Leo'],
      timeZone: 'America/Toronto',
      language: 'fr',
    });
    expect(line).toEqual({
      language: 'fr',
      kids: ['Maya', 'Leo'],
      items: [
        {
          kind: 'plan',
          title: 'Maya swim pickup',
          day: 'vendredi 25 septembre',
          start: '15:00',
          end: '15:30',
          has: 'Barton',
        },
        {
          kind: 'plan',
          title: 'Leo daycare pickup',
          day: 'vendredi 25 septembre',
          start: '15:00',
          end: '15:30',
          has: 'Barton',
        },
      ],
      suggested: { name: 'Sam', takes: 'Leo daycare pickup' },
      alsoFree: [],
      busy: [],
      couldAsk: ['Rosa'],
    });
  });
});

describe('groupConflictTextUsable', () => {
  it('takes one plain message with one question at most', () => {
    expect(groupConflictTextUsable('  Maya and Leo both need pickup at 3. Sam, can you?  ')).toBe(
      'Maya and Leo both need pickup at 3. Sam, can you?',
    );
    expect(groupConflictTextUsable('')).toBeNull();
    expect(groupConflictTextUsable('   ')).toBeNull();
    expect(groupConflictTextUsable('Can Sam? Or Barton?')).toBeNull();
    expect(groupConflictTextUsable('Sam peut-il ? Ou Barton ？')).toBeNull();
    expect(groupConflictTextUsable('Pick a time: https://hale.example/fix')).toBeNull();
    expect(groupConflictTextUsable('See www.hale.example')).toBeNull();
  });
});
