import { describe, expect, it } from 'vitest';
import { type CartForCompare, compareCart } from './cart';
import type { SignupTermsApprovedSession } from './types';

const who = { childFirstName: 'Ada', siblingFirstNames: [], timeZone: 'America/Toronto' };

const bound = (over: Partial<SignupTermsApprovedSession> = {}): SignupTermsApprovedSession => ({
  sessionId: 's-1',
  program: { courseIds: ['283993', 'ev-1'], name: 'Get Ready Public Speaking' },
  startsAt: '2026-03-28T09:30:00',
  sharesDate: false,
  amount: { kind: 'exact', cents: [8488], currency: 'cad', plusTax: null, limitCents: null },
  ...over,
});

const cart = (over: Partial<CartForCompare> = {}): CartForCompare => ({
  provider_course_id: '283993',
  session_label: 'Get Ready Public Speaking',
  session_date: '2026-03-28',
  session_time: '09:30',
  participant_first_name: 'Ada',
  line_count: 1,
  quantity: 1,
  totalCents: 8488,
  taxCents: 0,
  feesCents: 0,
  currency: 'cad',
  ...over,
});

const plusTax = (basisPoints: number, kind: 'rate' | 'ceiling' = 'rate') =>
  bound({
    amount: {
      kind: 'exact',
      cents: [33627],
      currency: 'cad',
      plusTax: { kind, basisPoints },
      limitCents: null,
    },
  });

describe('compareCart', () => {
  it('passes the exact cart at both stages (positive control)', () => {
    expect(compareCart(bound(), cart(), who, 'cart')).toEqual([]);
    expect(compareCart(bound(), cart(), who, 'final')).toEqual([]);
  });

  describe('the kid', () => {
    const named = (childFirstName: string, siblingFirstNames: string[], cartName: string) =>
      compareCart(
        bound(),
        cart({ participant_first_name: cartName }),
        { childFirstName, siblingFirstNames, timeZone: who.timeZone },
        'cart',
      ).includes('kid');

    it.each([
      ['the full stored name', 'Anne Marie', [], 'Anne Marie'],
      ['case and spacing aside', 'Anne Marie', [], '  anne   MARIE '],
      ['the stored name plus a surname', 'Anne Marie', [], 'Anne Marie Lovelace'],
      ['a shorter name no sibling shares', 'Anne Marie', ['Sophie'], 'Anne'],
      ['a stored short name plus a surname', 'Anne', ['Anne Marie'], 'Anne Lovelace'],
      ['the exact name beside a longer sibling', 'Anne', ['Anne Marie'], 'Anne'],
    ])('passes %s', (_case, child, siblings, cartName) => {
      expect(named(child, siblings, cartName)).toBe(false);
    });

    it.each([
      ['a sibling sharing the first word', 'Anne Marie', [], 'Anne Sophie'],
      ['a shorter name a sibling also starts with', 'Anne Marie', ['Anne Sophie'], 'Anne'],
      ['the exact name of a sibling', 'Anne', ['Anne Marie'], 'Anne Marie'],
      ['a name both children start', 'Anne', ['Anne Marie'], 'Anne Marie Lovelace'],
      ['another name', 'Ada', [], 'Sophie'],
    ])('stops on %s', (_case, child, siblings, cartName) => {
      expect(named(child, siblings, cartName)).toBe(true);
    });
  });

  it('one cent over stops', () => {
    expect(compareCart(bound(), cart({ totalCents: 8489 }), who, 'final')).toEqual(['price']);
    expect(compareCart(bound(), cart({ totalCents: 8489 }), who, 'cart')).toEqual(['price']);
  });

  it('one cent under stops at the final stage', () => {
    expect(compareCart(bound(), cart({ totalCents: 8487 }), who, 'final')).toEqual(['price']);
  });

  it('an extra fee stops as fees', () => {
    expect(compareCart(bound(), cart({ totalCents: 9488, feesCents: 1000 }), who, 'final')).toEqual(
      ['fees'],
    );
  });

  it('a non-resident rate on a resident binding stops', () => {
    expect(compareCart(bound(), cart({ totalCents: 9760 }), who, 'final')).toEqual(['price']);
  });

  it('another date with the same label stops', () => {
    expect(compareCart(bound(), cart({ session_date: '2026-04-04' }), who, 'cart')).toEqual([
      'session',
    ]);
  });

  it('the same date, time and price with a different label stops', () => {
    expect(
      compareCart(
        bound(),
        cart({ provider_course_id: null, session_label: 'Chess: Preschool' }),
        who,
        'cart',
      ),
    ).toEqual(['session']);
  });

  it('a different course id stops', () => {
    expect(compareCart(bound(), cart({ provider_course_id: '344301' }), who, 'cart')).toEqual([
      'session',
    ]);
  });

  it('a null time passes when no other session shares the date', () => {
    expect(compareCart(bound(), cart({ session_time: null }), who, 'cart')).toEqual([]);
  });

  it('a null time stops when another session shares the date', () => {
    expect(
      compareCart(bound({ sharesDate: true }), cart({ session_time: null }), who, 'cart'),
    ).toEqual(['session']);
  });

  it('a cart time with no leading zero is the same time, and another time is not', () => {
    expect(compareCart(bound(), cart({ session_time: '9:30' }), who, 'cart')).toEqual([]);
    expect(compareCart(bound(), cart({ session_time: '9:45' }), who, 'cart')).toEqual(['session']);
  });

  it('an offset start compares in the portal zone', () => {
    expect(compareCart(bound({ startsAt: '2026-03-28T13:30:00Z' }), cart(), who, 'cart')).toEqual(
      [],
    );
  });

  it.each(['Addie', 'Ava'])('a different first name stops (%s)', (name) => {
    expect(compareCart(bound(), cart({ participant_first_name: name }), who, 'cart')).toEqual([
      'kid',
    ]);
  });

  it('quantity 2 stops', () => {
    expect(compareCart(bound(), cart({ quantity: 2 }), who, 'cart')).toEqual(['quantity']);
  });

  it('two lines stop', () => {
    expect(compareCart(bound(), cart({ line_count: 2 }), who, 'cart')).toEqual(['quantity']);
  });

  it('another currency stops', () => {
    expect(compareCart(bound(), cart({ currency: 'usd' }), who, 'final')).toEqual(['price']);
  });

  it('a null currency is unread', () => {
    expect(compareCart(bound(), cart({ currency: null }), who, 'final')).toEqual(['unread']);
  });

  it.each([
    ['provider_course_id and session_label', { provider_course_id: null, session_label: null }],
    ['session_date', { session_date: null }],
    ['participant_first_name', { participant_first_name: null }],
    ['line_count', { line_count: null }],
    ['quantity', { quantity: null }],
    ['totalCents', { totalCents: null }],
  ])('a null %s is unread', (_name, patch) => {
    expect(compareCart(bound(), cart(patch), who, 'final')).toContain('unread');
  });

  it('13% tax on a registry portal passes, two cents off fails', () => {
    const tax = 4372;
    expect(
      compareCart(plusTax(1300), cart({ totalCents: 33627 + tax, taxCents: tax }), who, 'final'),
    ).toEqual([]);
    expect(
      compareCart(
        plusTax(1300),
        cart({ totalCents: 33627 + tax + 2, taxCents: tax + 2 }),
        who,
        'final',
      ),
    ).toEqual(['price']);
  });

  it('on another portal 15% passes and over it fails', () => {
    const tax = 5044;
    expect(
      compareCart(
        plusTax(1500, 'ceiling'),
        cart({ totalCents: 33627 + tax, taxCents: tax }),
        who,
        'final',
      ),
    ).toEqual([]);
    expect(
      compareCart(
        plusTax(1500, 'ceiling'),
        cart({ totalCents: 33627 + tax + 1, taxCents: tax + 1 }),
        who,
        'final',
      ),
    ).toEqual(['price']);
  });

  it('a plus-tax cart with a null tax line is unread', () => {
    expect(
      compareCart(plusTax(1300), cart({ totalCents: 37999, taxCents: null }), who, 'final'),
    ).toEqual(['unread']);
  });

  it('a zero cart on a paid binding stops at the cart', () => {
    expect(compareCart(bound(), cart({ totalCents: 0 }), who, 'cart')).toEqual(['price']);
  });

  it('a parent limit under the bound rate never lets the rate pass', () => {
    const limited = bound({
      amount: { kind: 'exact', cents: [8488], currency: 'cad', plusTax: null, limitCents: 8000 },
    });
    expect(compareCart(limited, cart(), who, 'final')).toEqual(['price']);
  });

  it('a ceiling passes at or under the number and stops over it', () => {
    const ceiling = bound({ amount: { kind: 'ceiling', cents: 10000, currency: 'cad' } });
    expect(compareCart(ceiling, cart({ totalCents: 10000 }), who, 'final')).toEqual([]);
    expect(compareCart(ceiling, cart({ totalCents: 10001 }), who, 'final')).toEqual(['price']);
  });

  it('a cart code is compared only when the page gave ids to compare it with', () => {
    const noIds = bound({ program: { courseIds: [], name: 'Parent & Tot Swim' } });
    const line = { provider_course_id: 'SW-881', session_label: 'Parent & Tot Swim' };
    expect(compareCart(noIds, cart(line), who, 'cart')).toEqual([]);
    expect(
      compareCart(noIds, cart({ ...line, session_label: 'Chess: Preschool' }), who, 'cart'),
    ).toEqual(['session']);
  });

  it('a binding with neither ids nor a name cannot pass a cart', () => {
    const blind = bound({ program: { courseIds: [], name: null } });
    expect(compareCart(blind, cart({ session_label: 'Anything' }), who, 'cart')).toEqual([
      'unread',
    ]);
  });

  describe('a class free at one rate and paid at the other', () => {
    const pair = bound({
      amount: { kind: 'exact', cents: [0, 4000], currency: 'cad', plusTax: null, limitCents: null },
    });

    it('passes a $0 cart, with no currency to read, at both stages', () => {
      const zero = cart({ totalCents: 0, currency: null, taxCents: null, feesCents: null });
      expect(compareCart(pair, zero, who, 'cart')).toEqual([]);
      expect(compareCart(pair, zero, who, 'final')).toEqual([]);
    });

    it('passes the paid rate and nothing else', () => {
      expect(compareCart(pair, cart({ totalCents: 4000 }), who, 'cart')).toEqual([]);
      expect(compareCart(pair, cart({ totalCents: 4000 }), who, 'final')).toEqual([]);
      expect(compareCart(pair, cart({ totalCents: 2000 }), who, 'final')).toEqual(['price']);
      expect(compareCart(pair, cart({ totalCents: 4001 }), who, 'cart')).toEqual(['price']);
    });

    it('a limit the parent wrote still stops the paid rate, and not the free one', () => {
      const limited = bound({
        amount: {
          kind: 'exact',
          cents: [0, 4000],
          currency: 'cad',
          plusTax: null,
          limitCents: 1000,
        },
      });
      expect(compareCart(limited, cart({ totalCents: 4000 }), who, 'final')).toEqual(['price']);
      expect(compareCart(limited, cart({ totalCents: 0, currency: null }), who, 'final')).toEqual(
        [],
      );
    });
  });

  it('a free binding passes on exactly zero, with no currency, and stops on one cent', () => {
    const free = bound({ amount: { kind: 'free' } });
    expect(
      compareCart(free, cart({ totalCents: 0, currency: null, feesCents: null }), who, 'final'),
    ).toEqual([]);
    expect(compareCart(free, cart({ totalCents: 100, currency: null }), who, 'final')).toEqual([
      'price',
    ]);
    expect(compareCart(free, cart({ totalCents: 100, currency: null }), who, 'cart')).toEqual([
      'price',
    ]);
  });
});
