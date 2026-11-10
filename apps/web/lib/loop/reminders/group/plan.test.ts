import { describe, expect, it } from 'vitest';
import { MAX_SET_PER_TURN, type PlanInput, planReminderTurn } from './plan';
import type { ReminderAsk } from './policy';

const TZ = 'America/Toronto';
const NOW = new Date('2026-10-28T18:00:00.000Z');
const QUIET = { timeZone: TZ, windows: [{ start: '21:00', end: '08:00' }] };

const GRAN = { userId: 'u-gran', phoneHash: 'h-gran', firstName: 'Ruth' };
const DAN = { userId: 'u-dan', phoneHash: 'h-dan', firstName: 'Dan' };
const PRIYA = { userId: 'u-priya', phoneHash: 'h-priya', firstName: 'Priya' };

function ask(overrides: Partial<ReminderAsk> = {}): ReminderAsk {
  return {
    for: 'sender',
    name: null,
    what: 'pick up Maya from swim',
    date: '2026-10-29',
    time: '16:00',
    inMinutes: null,
    where: 'unsaid',
    ...overrides,
  };
}

function input(overrides: Partial<PlanInput> & { set?: ReminderAsk[]; cancel?: string[] } = {}) {
  const { set = [ask()], cancel = [], ...rest } = overrides;
  return {
    reading: { request: 'reminders' as const, set, cancel, language: 'en' },
    now: NOW,
    timeZone: TZ,
    asker: { ...GRAN, haleCustomer: false, directReachable: false },
    seats: [GRAN, DAN, PRIYA],
    groupQuiet: QUIET,
    directQuiet: null,
    openRefs: new Map<string, string>(),
    ...rest,
  } satisfies PlanInput;
}

describe('planReminderTurn', () => {
  it("keeps a non-customer grandparent's own reminder in the group", () => {
    const plan = planReminderTurn(input({ set: [ask({ where: 'private' })] }));
    expect(plan.set).toHaveLength(1);
    expect(plan.set[0]).toMatchObject({
      forKind: 'sender',
      forUserId: GRAN.userId,
      forPhoneHash: GRAN.phoneHash,
      delivery: 'group',
      moved: null,
      privateAsked: true,
    });
    expect(plan.set[0]?.deliverAt.toISOString()).toBe('2026-10-29T20:00:00.000Z');
  });

  it("sends a reachable customer's own reminder 1:1 under their own quiet hours", () => {
    const plan = planReminderTurn(
      input({
        asker: { ...PRIYA, haleCustomer: true, directReachable: true },
        directQuiet: { timeZone: TZ, windows: [{ start: '21:30:00', end: '07:30:00' }] },
        set: [ask({ time: '21:15' })],
      }),
    );
    expect(plan.set[0]).toMatchObject({ delivery: 'direct', moved: null });
  });

  it('falls back to the group when a 1:1 cannot be reached', () => {
    const plan = planReminderTurn(
      input({ asker: { ...PRIYA, haleCustomer: true, directReachable: false } }),
    );
    expect(plan.set[0]?.delivery).toBe('group');
  });

  it('posts a reminder for someone else in the group, tied to their seat', () => {
    const plan = planReminderTurn(input({ set: [ask({ for: 'person', name: 'dan' })] }));
    expect(plan.set[0]).toMatchObject({
      forKind: 'person',
      forUserId: DAN.userId,
      forPhoneHash: DAN.phoneHash,
      forName: 'Dan',
      delivery: 'group',
    });
  });

  it('sets nothing for someone who is not in the chat, and says who', () => {
    const plan = planReminderTurn(
      input({
        set: [
          ask({ for: 'person', name: 'Sam' }),
          ask({ for: 'person', name: 'Sam', what: 'call the vet', time: null }),
          ask({ for: 'person', name: 'Dan', what: 'bring the chairs' }),
        ],
      }),
    );
    expect(plan.set.map((planned) => planned.forName)).toEqual(['Dan']);
    expect(plan.needsTime).toEqual([]);
    expect(plan.notSet).toEqual([
      { forName: 'Sam', what: 'pick up Maya from swim', why: 'not_in_chat' },
      { forName: 'Sam', what: 'call the vet', why: 'not_in_chat' },
    ]);
  });

  it("settles a shared first name when the asker answers with one seat's whole name", () => {
    const danLee = { ...DAN, fullName: 'Dan Lee' };
    const danOkafor = {
      userId: 'u-dan-2',
      phoneHash: 'h-dan-2',
      firstName: 'Dan',
      fullName: 'Dan Okafor',
    };
    const seats = [GRAN, danLee, PRIYA, danOkafor];
    const answered = planReminderTurn(
      input({ seats, set: [ask({ for: 'person', name: 'dan okafor' })] }),
    );
    expect(answered.set.map((planned) => planned.forUserId)).toEqual(['u-dan-2']);
    expect(answered.notSet).toEqual([]);
    // A first name alone, or a whole name nobody here has, still sets nothing.
    for (const name of ['Dan', 'Dan Smith']) {
      const plan = planReminderTurn(input({ seats, set: [ask({ for: 'person', name })] }));
      expect(plan.set).toEqual([]);
      expect(plan.notSet.map((row) => row.why)).toEqual(['name_shared']);
    }
  });

  it('sets nothing for a name two people in the chat share', () => {
    const secondDan = { userId: 'u-dan-2', phoneHash: 'h-dan-2', firstName: 'Dan' };
    const plan = planReminderTurn(
      input({ seats: [GRAN, DAN, PRIYA, secondDan], set: [ask({ for: 'person', name: 'Dan' })] }),
    );
    expect(plan.set).toEqual([]);
    expect(plan.notSet).toEqual([
      { forName: 'Dan', what: 'pick up Maya from swim', why: 'name_shared' },
    ]);
  });

  it('skips a reminder for a person with no name', () => {
    const plan = planReminderTurn(input({ set: [ask({ for: 'person', name: null })] }));
    expect(plan.set).toEqual([]);
    expect(plan.notSet).toEqual([]);
  });

  it('moves a reminder asked for inside quiet hours and says which way', () => {
    const plan = planReminderTurn(input({ set: [ask({ time: '21:30' })] }));
    expect(plan.set[0]?.moved).toBe('earlier');
    expect(plan.set[0]?.askedFor.toISOString()).toBe('2026-10-30T01:30:00.000Z');
    expect(plan.set[0]?.deliverAt.toISOString()).toBe('2026-10-30T00:45:00.000Z');
  });

  it('asks when, and sets nothing, for a reminder with no usable time', () => {
    const plan = planReminderTurn(input({ set: [ask({ time: null })] }));
    expect(plan.set).toEqual([]);
    expect(plan.needsTime).toEqual([
      {
        forKind: 'sender',
        forName: 'Ruth',
        what: 'pick up Maya from swim',
        day: 'Thursday, October 29, 2026',
      },
    ]);
  });

  it('maps the cancel refs it was shown, and ignores any it was not', () => {
    const plan = planReminderTurn(
      input({ set: [], cancel: ['r2', 'r9', 'r2'], openRefs: new Map([['r2', 'row-2']]) }),
    );
    expect(plan.cancelIds).toEqual(['row-2']);
  });

  it('sets each reminder once and at most a handful per message', () => {
    const many = Array.from({ length: 8 }, (_, i) => ask({ what: `thing ${i}` }));
    expect(planReminderTurn(input({ set: many })).set).toHaveLength(MAX_SET_PER_TURN);
    expect(planReminderTurn(input({ set: [ask(), ask()] })).set).toHaveLength(1);
  });
});
