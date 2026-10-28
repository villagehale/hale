import { describe, expect, it } from 'vitest';
import { worstCaseUsd } from '../../../web/lib/testing/spend-cap.mjs';
import { GROUP_REMINDER_FIXTURES, GROUP_REMINDER_HOUSEHOLDS } from '../group-reminder-fixtures.mjs';
import {
  brokenPlan,
  brokenText,
  fixedCopyFailures,
  maxSends,
  offlineInputTokens,
  planFailures,
  priceCall,
  readingFailures,
} from './group-reminder-gates.mjs';
import { PRICE, priceRates } from './harness.mjs';

/**
 * The structural half of evals/group-reminder-eval.mjs (VIL-448). The runner hands these
 * gates the runtime's own askedInstant / sameFirstName / inQuiet; here they get stand-ins,
 * because what is under test is the gate, not the policy (the policy has its own tests in
 * apps/web/lib/loop/reminders/group).
 */

// A stand-in for askedInstant: a bare time is today's.
const instantOf = (ask) => {
  if (ask.time === null) return null;
  return new Date(`${ask.date ?? '2026-10-28'}T${ask.time}:00.000Z`);
};
const sameName = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();
const gates = { instantOf, sameName };

const ask = (over = {}) => ({
  for: 'sender',
  name: null,
  what: 'grab Maya from swim',
  date: '2026-10-29',
  time: '16:00',
  inMinutes: null,
  where: 'unsaid',
  ...over,
});

const expectOne = (over = {}) => ({
  request: 'reminders',
  language: 'en',
  set: [{ ...ask(), where: ['unsaid', 'group'], ...over }],
});

const reading = (over = {}) => ({
  request: 'reminders',
  set: [ask()],
  cancel: [],
  language: 'en',
  ...over,
});

describe('readingFailures', () => {
  it('passes a reading that means what the case means', () => {
    expect(readingFailures(expectOne(), reading(), gates)).toEqual([]);
  });

  it('compares times as the instant they resolve to, not the fields', () => {
    const want = expectOne({ date: '2026-10-28', time: '17:30' });
    expect(
      readingFailures(want, reading({ set: [ask({ date: null, time: '17:30' })] }), gates),
    ).toEqual([]);
  });

  it('fails who it is for, where it goes, the time, the cancels and the language', () => {
    const got = reading({
      set: [ask({ for: 'everyone', where: 'private', time: '04:00' })],
      cancel: ['r1'],
      language: 'fr-CA',
    });
    const failures = readingFailures(expectOne(), got, gates);
    expect(failures).toHaveLength(5);
  });

  it('fails a person reminder that names someone else', () => {
    const want = expectOne({ for: 'person', name: 'Dan' });
    const got = reading({ set: [ask({ for: 'person', name: 'Ruth' })] });
    expect(readingFailures(want, got, gates)).toEqual(['reminder 1 names Ruth, want Dan']);
  });

  it('reads a language tag by its primary subtag', () => {
    const want = { ...expectOne(), language: 'fr' };
    expect(readingFailures(want, reading({ language: 'fr-CA' }), gates)).toEqual([]);
  });

  it('fails an unread turn and a request read the wrong way', () => {
    expect(readingFailures(expectOne(), null, gates)).toHaveLength(1);
    expect(readingFailures({ request: 'other' }, reading(), gates)).toEqual([
      'request read as reminders, want other',
    ]);
    expect(
      readingFailures({ request: 'other' }, reading({ request: 'other', set: [] }), gates),
    ).toEqual([]);
  });
});

const planned = (over = {}) => ({
  forKind: 'sender',
  forUserId: 'u-ruth',
  forPhoneHash: 'h-ruth',
  forName: 'Ruth',
  what: 'put the bins out',
  askedFor: new Date('2026-10-29T02:30:00.000Z'),
  deliverAt: new Date('2026-10-29T00:45:00.000Z'),
  moved: 'earlier',
  delivery: 'group',
  privateAsked: false,
  ...over,
});

const quietAt = (item) =>
  item.deliverAt.getTime() === item.askedFor.getTime() && item.moved === null;

describe('planFailures', () => {
  const want = { plan: [{ delivery: 'group', moved: 'earlier' }] };

  it('passes the plan the case wants', () => {
    const plan = { set: [planned()], needsTime: [], notSet: [], cancelIds: [] };
    expect(planFailures(want, plan, { askerIsCustomer: false, quietAt })).toEqual([]);
  });

  it("never lets a non-customer's reminder go 1:1, whatever the case says", () => {
    const plan = {
      set: [planned({ delivery: 'direct' })],
      needsTime: [],
      notSet: [],
      cancelIds: [],
    };
    const failures = planFailures({ plan: [{ delivery: 'direct', moved: 'earlier' }] }, plan, {
      askerIsCustomer: false,
      quietAt,
    });
    expect(failures).toEqual(["reminder 1: a non-customer's reminder would be texted 1:1"]);
  });

  it('never texts someone 1:1 because another person asked', () => {
    const plan = {
      set: [planned({ forKind: 'person', delivery: 'direct' })],
      needsTime: [],
      notSet: [],
      cancelIds: [],
    };
    const failures = planFailures(want, plan, { askerIsCustomer: true, quietAt });
    expect(failures).toContain(
      'reminder 1: someone would be texted 1:1 because another person asked',
    );
  });

  it('fails a reminder due inside quiet hours, and a missed "when?"', () => {
    const plan = {
      set: [planned({ moved: null, deliverAt: planned().askedFor })],
      needsTime: [],
      notSet: [],
      cancelIds: [],
    };
    const failures = planFailures({ ...want, needsTime: 1 }, plan, {
      askerIsCustomer: false,
      quietAt,
    });
    expect(failures).toEqual([
      'reminder 1 quiet-hours move null, want earlier',
      '0 asked when, want 1',
      'reminder 1: due inside quiet hours',
    ]);
  });

  it('never sets a reminder for someone with no seat in the chat, whatever the case says', () => {
    const plan = {
      set: [planned({ forKind: 'person', forUserId: null, forPhoneHash: null, forName: 'Sam' })],
      needsTime: [],
      notSet: [],
      cancelIds: [],
    };
    expect(planFailures(want, plan, { askerIsCustomer: false, quietAt })).toEqual([
      'reminder 1: for Sam, who has no seat in the chat',
    ]);
  });

  it('fails a plan that sets what it should have said it could not', () => {
    const plan = { set: [planned()], needsTime: [], notSet: [], cancelIds: [] };
    expect(
      planFailures({ plan: [], notSet: 1 }, plan, { askerIsCustomer: false, quietAt }),
    ).toEqual(['1 reminders planned, want 0', '0 not set, want 1']);
  });
});

describe('fixedCopyFailures', () => {
  it('flags one text written for different facts', () => {
    const failures = fixedCopyFailures([
      { id: 'a', kind: 'confirm', factsKey: '{"what":"swim"}', text: 'Reminder set!' },
      { id: 'b', kind: 'confirm', factsKey: '{"what":"bins"}', text: 'Reminder set!' },
      { id: 'c', kind: 'confirm', factsKey: '{"what":"cake"}', text: 'Set for 5:30, Dan.' },
    ]);
    expect([...failures.keys()].sort()).toEqual(['a:confirm', 'b:confirm']);
  });

  it('does not flag the same text for the same facts, or across kinds', () => {
    const failures = fixedCopyFailures([
      { id: 'a', kind: 'confirm', factsKey: 'same', text: 'Done.' },
      { id: 'b', kind: 'confirm', factsKey: 'same', text: 'Done.' },
      { id: 'c', kind: 'reminder', factsKey: 'other', text: 'Done.' },
    ]);
    expect(failures.size).toBe(0);
  });
});

describe('the broken arm', () => {
  it('texts the asker 1:1 and keeps the quiet-hours time', () => {
    const plan = brokenPlan({
      set: [planned(), planned({ forKind: 'person', forName: 'Dan', forPhoneHash: 'h-dan' })],
      needsTime: [],
      notSet: [],
      cancelIds: [],
    });
    expect(plan.set[0]).toMatchObject({ delivery: 'direct', moved: null });
    expect(plan.set[0].deliverAt).toEqual(plan.set[0].askedFor);
    expect(plan.set[1].delivery).toBe('group');
    const failures = planFailures(
      {
        plan: [
          { delivery: 'group', moved: 'earlier' },
          { delivery: 'group', moved: 'earlier' },
        ],
      },
      plan,
      { askerIsCustomer: false, quietAt },
    );
    expect(failures).toContain("reminder 1: a non-customer's reminder would be texted 1:1");
    expect(failures).toContain('reminder 1: due inside quiet hours');
  });

  it('writes one fixed confirmation, which the fixed-copy gate catches', () => {
    const texts = [{ what: 'swim' }, { what: 'bins' }].map((facts, i) => ({
      id: String(i),
      kind: 'confirm',
      factsKey: JSON.stringify(facts),
      text: brokenText({ kind: 'confirm', ...facts }),
    }));
    expect(fixedCopyFailures(texts).size).toBe(2);
  });
});

describe('the --dry worst case', () => {
  it('counts every send a structured call can make', () => {
    expect(maxSends({ thinking: 'adaptive' })).toBe(3);
    expect(maxSends({ thinking: 'disabled' })).toBe(2);
  });

  it("prices a send at the spend guard's worst case and every attempt and re-ask on top", () => {
    const request = {
      model: 'claude-haiku-5-5',
      max_tokens: 300,
      system: [{ type: 'text', text: 'x'.repeat(2998), cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: 'hi' }],
    };
    const tokens = offlineInputTokens(request);
    const { input, output } = PRICE['claude-haiku-5-5'];
    const perSend = (tokens * input * 1.25 + 300 * output) / 1e6;
    const priced = priceCall({
      request,
      lane: { thinking: 'disabled' },
      attempts: 2,
      rates: priceRates,
      worstCaseUsd,
    });
    expect(priced.perSend).toBeCloseTo(perSend, 12);
    expect(priced.ceiling).toBeCloseTo(perSend * 2 * 2, 12);
  });
});

describe('the fixtures', () => {
  const ids = GROUP_REMINDER_FIXTURES.map((fixture) => fixture.id);

  it('cover every case the ticket names', () => {
    for (const id of [
      'grandparent-own',
      'remind-dan',
      'quiet-hours',
      'stop-before-fire',
      'french',
    ]) {
      expect(ids).toContain(id);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('give every text a case expects something for the judge to check', () => {
    for (const fixture of GROUP_REMINDER_FIXTURES) {
      const sets = fixture.expect.request === 'reminders';
      expect(Boolean(fixture.confirmMustSay), fixture.id).toBe(sets);
      const fires = sets && (fixture.expect.plan ?? []).length > 0 && !fixture.fire?.expectDrop;
      expect(Boolean(fixture.reminderMustSay), fixture.id).toBe(fires);
    }
  });

  it('seat every sender, and only a customer can be reached 1:1', () => {
    for (const fixture of GROUP_REMINDER_FIXTURES) {
      const household = GROUP_REMINDER_HOUSEHOLDS[fixture.household];
      expect(
        household.seats.some((seat) => seat.firstName === fixture.sender),
        fixture.id,
      ).toBe(true);
    }
    for (const household of Object.values(GROUP_REMINDER_HOUSEHOLDS)) {
      for (const seat of household.seats) {
        if (!seat.haleCustomer) expect(seat.directReachable).toBeUndefined();
      }
    }
  });

  it('keep every non-customer case in the group', () => {
    for (const fixture of GROUP_REMINDER_FIXTURES) {
      const household = GROUP_REMINDER_HOUSEHOLDS[fixture.household];
      const sender = household.seats.find((seat) => seat.firstName === fixture.sender);
      if (sender.haleCustomer) continue;
      for (const item of fixture.expect.plan ?? []) expect(item.delivery, fixture.id).toBe('group');
    }
  });
});
