import { describe, expect, it } from 'vitest';
import { type BindInput, bindApproval } from './bind';
import { signupTermsApprovedSchema } from './store';
import type { SignupTermsShown } from './types';

const shown = (over: Partial<SignupTermsShown> = {}): SignupTermsShown => ({
  v: 1,
  read: 'course_model',
  program: { courseIds: ['283993'], name: 'Get Ready Public Speaking' },
  residency: 'resident',
  age: { fit: 'in_band', band: '4 to 6', rule: null },
  prerequisite: { required: 'no', quote: null },
  refund: null,
  currency: 'cad',
  countsAgainstSeason: false,
  priorChargeUnknown: false,
  sessions: [
    {
      sessionId: 's-1',
      rates: [
        { rate: 'resident', cents: 8488 },
        { rate: 'non_resident', cents: 9760 },
      ],
      tax: 'included',
      source: 'course_model',
    },
  ],
  ...over,
});

const input = (over: Partial<BindInput> = {}): BindInput => ({
  shown: shown(),
  askedMessageId: 'm-1',
  sessions: [{ id: 's-1', label: 'Sat 9:30', startsAt: '2026-03-28T09:30:00' }],
  activityLabel: null,
  choiceIds: ['s-1'],
  limitWrittenCents: null,
  prerequisiteMet: null,
  ageFit: 'in_band',
  taxBound: { kind: 'rate', basisPoints: 1300 },
  timeZone: 'America/Toronto',
  ...over,
});

describe('bindApproval', () => {
  it('a known resident binds the resident rate only', () => {
    const got = bindApproval(input());
    expect(got.kind).toBe('bound');
    if (got.kind !== 'bound') return;
    expect(got.approved.sessions[0]?.amount).toEqual({
      kind: 'exact',
      cents: [8488],
      currency: 'cad',
      plusTax: null,
      limitCents: null,
    });
    expect(got.approved.maxCents).toBe(8488);
    expect(got.approved.hold).toBeNull();
    expect(got.approved.quantity).toBe(1);
  });

  it('a session that was never shown binds nothing, whatever limit they wrote', () => {
    const got = bindApproval(
      input({
        sessions: [
          { id: 's-1', label: 'Sat 9:30', startsAt: '2026-03-28T09:30:00' },
          { id: 's-2', label: 'Sun 9:30', startsAt: '2026-03-29T09:30:00' },
        ],
        choiceIds: ['s-2'],
        limitWrittenCents: 5000,
      }),
    );
    expect(got).toEqual({ kind: 'terms_unsent' });
  });

  it('a known non-resident binds the non-resident rate only', () => {
    const got = bindApproval(input({ shown: shown({ residency: 'non_resident' }) }));
    expect(got.kind === 'bound' && got.approved.sessions[0]?.amount).toMatchObject({
      cents: [9760],
    });
  });

  it('unknown residency binds both rates', () => {
    const got = bindApproval(input({ shown: shown({ residency: 'unknown' }) }));
    expect(got.kind === 'bound' && got.approved.sessions[0]?.amount).toMatchObject({
      cents: [8488, 9760],
    });
    expect(got.kind === 'bound' && got.approved.maxCents).toBe(9760);
  });

  it('"yes, up to $100" on a known $84.88 stays exact, with the limit', () => {
    const got = bindApproval(input({ limitWrittenCents: 10000 }));
    expect(got.kind === 'bound' && got.approved.sessions[0]?.amount).toEqual({
      kind: 'exact',
      cents: [8488],
      currency: 'cad',
      plusTax: null,
      limitCents: 10000,
    });
    expect(got.kind === 'bound' && got.approved.maxCents).toBe(8488);
  });

  it('a limit below the rate asks instead of binding', () => {
    expect(bindApproval(input({ limitWrittenCents: 8000 }))).toEqual({
      kind: 'clarify',
      reason: 'limit_below_rate',
    });
  });

  it('a ceiling binds only when no rate was read', () => {
    const noRate = shown({
      sessions: [{ sessionId: 's-1', rates: [], tax: 'unknown', source: 'offer' }],
    });
    const got = bindApproval(input({ shown: noRate, limitWrittenCents: 12000 }));
    expect(got.kind === 'bound' && got.approved.sessions[0]?.amount).toEqual({
      kind: 'ceiling',
      cents: 12000,
      currency: 'cad',
    });
    expect(got.kind === 'bound' && got.approved.maxCents).toBe(12000);
  });

  it('no rate and no number asks for one', () => {
    const noRate = shown({
      sessions: [{ sessionId: 's-1', rates: [], tax: 'unknown', source: 'offer' }],
    });
    expect(bindApproval(input({ shown: noRate }))).toEqual({
      kind: 'clarify',
      reason: 'no_amount',
    });
  });

  it('a free class binds free, at zero', () => {
    const free = shown({
      sessions: [
        {
          sessionId: 's-1',
          rates: [{ rate: 'flat', cents: 0 }],
          tax: 'included',
          source: 'course_model',
        },
      ],
    });
    const got = bindApproval(input({ shown: free }));
    expect(got.kind === 'bound' && got.approved.sessions[0]?.amount).toEqual({ kind: 'free' });
    expect(got.kind === 'bound' && got.approved.maxCents).toBe(0);
  });

  it('plus-tax binds the tax bound, and the maximum carries it', () => {
    const taxed = shown({
      sessions: [
        {
          sessionId: 's-1',
          rates: [{ rate: 'resident', cents: 33627 }],
          tax: 'plus_tax',
          source: 'course_model',
        },
      ],
    });
    const got = bindApproval(input({ shown: taxed }));
    expect(got.kind === 'bound' && got.approved.sessions[0]?.amount).toMatchObject({
      cents: [33627],
      plusTax: { kind: 'rate', basisPoints: 1300 },
    });
    // 13% of $336.27 is $43.72, plus the one cent the rate check allows.
    expect(got.kind === 'bound' && got.approved.maxCents).toBe(33627 + 4372 + 1);
  });

  it('an unconfirmed prerequisite does not bind', () => {
    const needs = shown({ prerequisite: { required: 'yes', quote: 'Level 2 required' } });
    expect(bindApproval(input({ shown: needs, prerequisiteMet: null }))).toEqual({
      kind: 'clarify',
      reason: 'prerequisite',
    });
    expect(bindApproval(input({ shown: needs, prerequisiteMet: false }))).toEqual({
      kind: 'clarify',
      reason: 'prerequisite',
    });
    const met = bindApproval(input({ shown: needs, prerequisiteMet: true }));
    expect(met.kind === 'bound' && met.approved.prerequisiteConfirmed).toBe(true);
  });

  it('a child now outside the band does not bind', () => {
    expect(bindApproval(input({ ageFit: 'outside_band' }))).toEqual({ kind: 'outside_band' });
  });

  it('an unknown age binds and holds at checkout', () => {
    const got = bindApproval(input({ ageFit: 'unknown' }));
    expect(got.kind === 'bound' && got.approved.hold).toBe('age_unconfirmed');
  });

  it('terms that never reached the parent bind nothing', () => {
    expect(bindApproval(input({ askedMessageId: null }))).toEqual({ kind: 'terms_unsent' });
  });

  it('an earlier unknown charge holds, ahead of an unknown age', () => {
    const got = bindApproval(
      input({ shown: shown({ priorChargeUnknown: true }), ageFit: 'unknown' }),
    );
    expect(got.kind === 'bound' && got.approved.hold).toBe('prior_charge_unknown');
  });

  it('a site option holds', () => {
    const option = shown({
      sessions: [
        {
          sessionId: 's-1',
          rates: [{ rate: 'flat', cents: 8488 }],
          tax: 'unknown',
          source: 'site_option',
        },
      ],
    });
    const got = bindApproval(input({ shown: option }));
    expect(got.kind === 'bound' && got.approved.hold).toBe('site_option');
  });

  it('marks a session that shares its start date with another offered one', () => {
    const two = input({
      sessions: [
        { id: 's-1', label: 'Sat 9:30', startsAt: '2026-03-28T09:30:00' },
        { id: 's-2', label: 'Sat 11:00', startsAt: '2026-03-28T11:00:00' },
      ],
      shown: shown({
        sessions: ['s-1', 's-2'].map((sessionId) => ({
          sessionId,
          rates: [{ rate: 'resident' as const, cents: 8488 }],
          tax: 'included' as const,
          source: 'course_model' as const,
        })),
      }),
    });
    const got = bindApproval(two);
    expect(got.kind === 'bound' && got.approved.sessions[0]?.sharesDate).toBe(true);
  });

  it('keeps the ranked order of the choices', () => {
    const two = input({
      sessions: [
        { id: 's-1', label: 'Sat 9:30', startsAt: '2026-03-28T09:30:00' },
        { id: 's-2', label: 'Sun 11:00', startsAt: '2026-03-29T11:00:00' },
      ],
      choiceIds: ['s-2', 's-1'],
      shown: shown({
        sessions: ['s-1', 's-2'].map((sessionId) => ({
          sessionId,
          rates: [{ rate: 'resident' as const, cents: 8488 }],
          tax: 'included' as const,
          source: 'course_model' as const,
        })),
      }),
    });
    const got = bindApproval(two);
    expect(got.kind === 'bound' && got.approved.sessions.map((s) => s.sessionId)).toEqual([
      's-2',
      's-1',
    ]);
  });

  it('with no program name on the page, the name bound is the offer activity', () => {
    const got = bindApproval(
      input({
        shown: shown({ program: { courseIds: [], name: null } }),
        activityLabel: 'Parent & Tot Swim',
      }),
    );
    expect(got.kind === 'bound' && got.approved.sessions[0]?.program).toEqual({
      courseIds: [],
      name: 'Parent & Tot Swim',
    });
  });

  it('a name the page gave wins over the activity', () => {
    const got = bindApproval(input({ activityLabel: 'Speaking class' }));
    expect(got.kind === 'bound' && got.approved.sessions[0]?.program.name).toBe(
      'Get Ready Public Speaking',
    );
  });

  it('with neither, no name is bound: a session label is not a class name', () => {
    const got = bindApproval(input({ shown: shown({ program: { courseIds: [], name: null } }) }));
    expect(got.kind === 'bound' && got.approved.sessions[0]?.program.name).toBeNull();
  });

  describe('a class free for residents and paid for others', () => {
    const pair = shown({
      residency: 'unknown',
      sessions: [
        {
          sessionId: 's-1',
          rates: [
            { rate: 'resident', cents: 0 },
            { rate: 'non_resident', cents: 4000 },
          ],
          tax: 'included',
          source: 'course_model',
        },
      ],
    });

    it('binds both rates while residency is unknown, in a row the store can read back', () => {
      const got = bindApproval(input({ shown: pair }));
      expect(got.kind === 'bound' && got.approved.sessions[0]?.amount).toEqual({
        kind: 'exact',
        cents: [0, 4000],
        currency: 'cad',
        plusTax: null,
        limitCents: null,
      });
      expect(got.kind === 'bound' && got.approved.maxCents).toBe(4000);
      expect(
        got.kind === 'bound' && signupTermsApprovedSchema.safeParse(got.approved).success,
      ).toBe(true);
    });

    it('binds the free rate alone for a known resident', () => {
      const got = bindApproval(input({ shown: { ...pair, residency: 'resident' } }));
      expect(got.kind === 'bound' && got.approved.sessions[0]?.amount).toEqual({ kind: 'free' });
    });

    it('a stored amount of only zero cents is not an exact price', () => {
      const got = bindApproval(input({ shown: pair }));
      if (got.kind !== 'bound') throw new Error('not bound');
      const zeroes = {
        ...got.approved,
        sessions: got.approved.sessions.map((session) => ({
          ...session,
          amount: { ...session.amount, cents: [0] },
        })),
      };
      expect(signupTermsApprovedSchema.safeParse(zeroes).success).toBe(false);
    });
  });
});
