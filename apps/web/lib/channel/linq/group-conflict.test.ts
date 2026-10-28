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
  return {
    start: AT_3,
    end: AT_330,
    holders: [],
    takerId: null,
    claimed: false,
    rows: [],
    ...over,
  };
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
      busy: [{ key: 'busy:1', personId: 'barton', start: AT_330, end: AT_4, known: false }],
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
      busy: [{ key: 'busy:sam', personId: 'sam', start: AT_3, end: AT_4, known: false }],
      people: [barton, sam, rosa],
      now: NOW,
    });
    expect(clash?.suggested).toBeNull();
    expect(clash?.busy).toEqual(['sam']);
    expect(clash?.couldAsk).toEqual(['rosa']);
  });

  it('counts busy time Hale holds for a taker whose calendar it cannot read', () => {
    const [clash] = findGroupClashes({
      plans: [plan({ key: 'a', title: 'Maya swim pickup', takerId: 'barton' })],
      busy: [{ key: 'plan:private', personId: 'barton', start: AT_3, end: AT_4, known: true }],
      people: [{ ...barton, calendar: false }, sam, rosa],
      now: NOW,
    });
    expect(clash && 'busy' in clash.second && clash.second.busy.personId).toBe('barton');
    expect(clash?.suggested).toEqual({ personId: 'sam', planKey: 'a' });
    expect(clash?.busy).toEqual(['barton']);
    expect(clash?.couldAsk).toEqual(['rosa']);
  });

  it('keeps whoever has a plan already under way from being called free', () => {
    const swim = plan({
      key: 'swim',
      title: 'Maya swim',
      holders: ['sam'],
      start: new Date(NOW.getTime() - 30 * 60 * 1000),
      end: AT_330,
    });
    const clashes = findGroupClashes({
      plans: [
        swim,
        plan({ key: 'a', title: 'Leo daycare pickup', holders: ['barton'] }),
        plan({ key: 'b', title: 'Ava piano pickup', holders: ['barton'] }),
      ],
      busy: [],
      people: [barton, sam],
      now: NOW,
    });
    expect(clashes).toHaveLength(1);
    expect(clashes[0]?.first.key).toBe('a');
    expect(clashes[0]?.suggested).toBeNull();
    expect(clashes[0]?.busy).toEqual(['sam']);
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

  it('never alerts about a plan someone took in the group, even against their calendar', () => {
    const swim = plan({ key: 'a', title: 'Maya swim pickup', holders: ['barton'] });
    const daycare = plan({ key: 'b', title: 'Leo daycare pickup', holders: ['barton'] });
    expect(
      findGroupClashes({ plans: [swim, daycare], busy: [], people: [barton, sam], now: NOW }),
    ).toHaveLength(1);
    const taken = { ...daycare, takerId: 'sam', claimed: true };
    expect(
      findGroupClashes({ plans: [swim, taken], busy: [], people: [barton, sam], now: NOW }),
    ).toEqual([]);
    expect(
      findGroupClashes({
        plans: [swim, taken],
        busy: [{ key: 'busy:sam', personId: 'sam', start: AT_3, end: AT_4, known: false }],
        people: [barton, sam],
        now: NOW,
      }),
    ).toEqual([]);
  });

  it('holds whoever took a plan busy then, for every other plan', () => {
    const [clash, ...rest] = findGroupClashes({
      plans: [
        plan({
          key: 'a',
          title: 'Maya swim pickup',
          holders: ['barton'],
          takerId: 'sam',
          claimed: true,
        }),
        plan({ key: 'b', title: 'Leo daycare pickup', holders: ['sam'] }),
      ],
      busy: [],
      people: [barton, sam],
      now: NOW,
    });
    expect(rest).toEqual([]);
    expect(clash?.first.key).toBe('b');
    expect(clash && 'busy' in clash.second && clash.second.busy).toMatchObject({
      key: 'a',
      personId: 'sam',
      known: true,
    });
    expect(clash?.suggested).toEqual({ personId: 'barton', planKey: 'b' });
  });

  it('keeps the dedupe key when someone takes one of the plans the group was told about', () => {
    const swim = plan({ key: 'a', title: 'Maya swim pickup', holders: ['barton'] });
    const daycare = plan({ key: 'b', title: 'Leo daycare pickup', holders: ['barton'] });
    const [told] = findGroupClashes({
      plans: [swim, daycare],
      busy: [],
      people: [barton, sam],
      now: NOW,
    });
    const [after] = findGroupClashes({
      plans: [{ ...swim, takerId: 'barton', claimed: true }, daycare],
      busy: [],
      people: [barton, sam],
      now: NOW,
    });
    expect(after?.first.key).toBe('b');
    expect(after && 'busy' in after.second && after.second.busy.key).toBe('a');
    expect(after?.dedupeKey).toBe(told?.dedupeKey);
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
          ownerSince: null,
          placedGoogleEventId: 'placed-allergist',
        },
      ],
      decided: noDecision,
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
      decided: noDecision,
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
          ownerSince: null,
          placedGoogleEventId: null,
        },
      ],
      decided: noDecision,
    });
    expect(calendar.plans).toEqual([]);
    expect(calendar.busy).toEqual([
      { key: 'busy:gcal-barton:work', personId: 'barton', start: AT_3, end: AT_330, known: false },
    ]);
  });

  it('keeps the calendar copy of a private plan with no end to busy time', () => {
    const calendar = clashCalendar({
      blocks: [block({ eventId: 'placed-allergist', title: 'Maya allergist' })],
      events: [
        {
          id: 'allergist',
          title: 'Maya allergist',
          start: AT_3,
          end: null,
          private: true,
          owner: null,
          ownerSince: null,
          placedGoogleEventId: 'placed-allergist',
        },
      ],
      decided: noDecision,
    });
    expect(calendar.plans).toEqual([]);
    expect(calendar.busy.map((row) => row.personId)).toEqual(['barton']);
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
          ownerSince: NOW,
          placedGoogleEventId: null,
        },
      ],
      decided: (startIso, titleNorm) =>
        startIso === AT_3.toISOString() && titleNorm === 'maya swim pickup'
          ? { takerId: 'sam', at: NOW, claim: false }
          : null,
    });
    expect(calendar.plans.map((row) => [row.title, row.takerId, row.claimed])).toEqual([
      ['Leo piano pickup', 'named:Grandma', false],
      ['Maya swim pickup', 'sam', false],
    ]);
    expect(calendar.named).toEqual([{ id: 'named:Grandma', name: 'Grandma', calendar: false }]);
  });

  it('settles a calendar plan someone took in the group', () => {
    const calendar = clashCalendar({
      blocks: [block({ eventId: 'swim', title: 'Maya swim pickup' })],
      events: [],
      decided: () => ({ takerId: 'sam', at: NOW, claim: true }),
    });
    expect(calendar.plans.map((row) => [row.takerId, row.claimed])).toEqual([['sam', true]]);
  });

  it('lets a claim outrank a duty owner set before it, never one set after', () => {
    const piano = {
      id: 'piano',
      title: 'Leo piano pickup',
      start: AT_3,
      end: AT_330,
      private: false,
      owner: { kind: 'named' as const, label: 'Grandma' },
      ownerSince: NOW,
      placedGoogleEventId: null,
    };
    const claimAt = (offsetMs: number) => () => ({
      takerId: 'sam',
      at: new Date(NOW.getTime() + offsetMs),
      claim: true,
    });
    const taker = (calendar: ReturnType<typeof clashCalendar>) =>
      calendar.plans.map((row) => [row.takerId, row.claimed]);

    const newer = clashCalendar({ blocks: [], events: [piano], decided: claimAt(60_000) });
    expect(taker(newer)).toEqual([['sam', true]]);
    expect(newer.named).toEqual([]);

    const older = clashCalendar({ blocks: [], events: [piano], decided: claimAt(-60_000) });
    expect(taker(older)).toEqual([['named:Grandma', false]]);
    expect(older.named).toEqual([{ id: 'named:Grandma', name: 'Grandma', calendar: false }]);

    const unowned = clashCalendar({
      blocks: [],
      events: [{ ...piano, owner: null, ownerSince: null }],
      decided: claimAt(-60_000),
    });
    expect(taker(unowned)).toEqual([['sam', true]]);
  });

  it('never lets a claim reach a private plan', () => {
    const calendar = clashCalendar({
      blocks: [],
      events: [
        {
          id: 'allergist',
          title: 'Maya allergist',
          start: AT_3,
          end: AT_4,
          private: true,
          owner: { kind: 'parent', userId: 'barton' },
          ownerSince: null,
          placedGoogleEventId: null,
        },
      ],
      decided: () => ({ takerId: 'sam', at: NOW, claim: true }),
    });
    expect(calendar.plans).toEqual([]);
    expect(calendar.busy.map((row) => row.personId)).toEqual(['barton']);
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
