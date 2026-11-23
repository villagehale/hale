import { describe, expect, it } from 'vitest';
import {
  type CheckoutSuccessState,
  type FamilyFacts,
  type SessionFacts,
  familyDecidedState,
  sessionFactsFromStripe,
  stripeDecidedState,
} from './checkout-success-view';

const FAMILY_ID = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-11-21T12:00:00.000Z');
const NOW_SECONDS = NOW.getTime() / 1000;

function session(over: Partial<SessionFacts> = {}): SessionFacts {
  return {
    id: 'cs_test_view',
    status: 'complete',
    paymentStatus: 'paid',
    tier: 'plus',
    fresh: true,
    justPaid: true,
    createdAt: NOW_SECONDS - 120,
    familyId: FAMILY_ID,
    subscriptionId: 'sub_view',
    subscriptionCreated: NOW_SECONDS - 60,
    subscriptionStatus: 'active',
    ...over,
  };
}

function family(over: Partial<FamilyFacts> = {}): FamilyFacts {
  return {
    familyId: FAMILY_ID,
    planTier: 'plus',
    priorTier: 'free',
    purchaseRefused: false,
    grantLanded: true,
    payerId: '22222222-2222-4222-8222-222222222222',
    payerHasThread: true,
    ...over,
  };
}

describe('stripeDecidedState', () => {
  const cases: Array<[string, Partial<SessionFacts>, CheckoutSuccessState | null]> = [
    ['an open session', { status: 'open', paymentStatus: 'unpaid' }, 'not_paid'],
    ['an expired session', { status: 'expired', paymentStatus: 'unpaid' }, 'not_paid'],
    ['a status Stripe did not send', { status: null, paymentStatus: 'unpaid' }, 'unknown'],
    ['an open session Stripe calls paid', { status: 'open', paymentStatus: 'paid' }, 'unknown'],
    ['a paid link past expires_at', { fresh: false }, 'receipt'],
    ['an unpaid link past expires_at', { fresh: false, paymentStatus: 'unpaid' }, 'unknown'],
    ['complete and unpaid', { paymentStatus: 'unpaid' }, 'pending'],
    ['complete with no payment required', { paymentStatus: 'no_payment_required' }, 'pending'],
    [
      'complete, unpaid, subscription incomplete',
      { paymentStatus: 'unpaid', subscriptionStatus: 'incomplete' },
      'pending',
    ],
    [
      'complete, unpaid, subscription canceled',
      { paymentStatus: 'unpaid', subscriptionStatus: 'canceled' },
      'unknown',
    ],
    [
      'complete, unpaid, subscription incomplete_expired',
      { paymentStatus: 'unpaid', subscriptionStatus: 'incomplete_expired' },
      'unknown',
    ],
    ['complete, paid, in the window', {}, null],
  ];

  it.each(cases)('%s', (_name, over, expected) => {
    expect(stripeDecidedState(session(over))).toBe(expected);
  });
});

describe('sessionFactsFromStripe', () => {
  const raw = {
    id: 'cs_test_raw',
    status: 'complete',
    payment_status: 'paid',
    created: NOW_SECONDS - 300,
    expires_at: NOW_SECONDS + 3600,
    client_reference_id: FAMILY_ID,
    metadata: { familyId: FAMILY_ID, tier: 'plus' },
    subscription: { id: 'sub_raw', created: NOW_SECONDS - 200, status: 'active' },
  };

  it('reads the expanded subscription and the family off the session', () => {
    expect(sessionFactsFromStripe(raw, 'plus', NOW)).toEqual({
      id: 'cs_test_raw',
      status: 'complete',
      paymentStatus: 'paid',
      tier: 'plus',
      fresh: true,
      justPaid: true,
      createdAt: NOW_SECONDS - 300,
      familyId: FAMILY_ID,
      subscriptionId: 'sub_raw',
      subscriptionCreated: NOW_SECONDS - 200,
      subscriptionStatus: 'active',
    });
  });

  it('treats a link exactly at expires_at, past it, or with no expires_at as past', () => {
    expect(sessionFactsFromStripe({ ...raw, expires_at: NOW_SECONDS }, 'plus', NOW).fresh).toBe(
      false,
    );
    expect(sessionFactsFromStripe({ ...raw, expires_at: NOW_SECONDS - 1 }, 'plus', NOW).fresh).toBe(
      false,
    );
    expect(sessionFactsFromStripe({ ...raw, expires_at: undefined }, 'plus', NOW).fresh).toBe(
      false,
    );
    expect(sessionFactsFromStripe({ ...raw, expires_at: 'soon' }, 'plus', NOW).fresh).toBe(false);
    expect(sessionFactsFromStripe({ ...raw, expires_at: NOW_SECONDS + 1 }, 'plus', NOW).fresh).toBe(
      true,
    );
  });

  it('counts the half hour after the subscription began as just paid, and nothing else', () => {
    const paidAt = (created: unknown) =>
      sessionFactsFromStripe(
        { ...raw, subscription: { id: 'sub_raw', created, status: 'active' } },
        'plus',
        NOW,
      ).justPaid;
    expect(paidAt(NOW_SECONDS - 1799)).toBe(true);
    expect(paidAt(NOW_SECONDS - 1800)).toBe(false);
    expect(paidAt(NOW_SECONDS - 86_000)).toBe(false);
    expect(paidAt(undefined)).toBe(false);
    expect(
      sessionFactsFromStripe({ ...raw, subscription: 'sub_plain' }, 'plus', NOW).justPaid,
    ).toBe(false);
  });

  it('reads a family id that is not a uuid as no family', () => {
    const facts = sessionFactsFromStripe(
      { ...raw, client_reference_id: 'not-a-uuid', metadata: { familyId: 'not-a-uuid' } },
      'plus',
      NOW,
    );
    expect(facts.familyId).toBeNull();
  });

  it('reads an unexpanded subscription as an id with no dates', () => {
    const facts = sessionFactsFromStripe({ ...raw, subscription: 'sub_plain' }, 'plus', NOW);
    expect(facts.subscriptionId).toBe('sub_plain');
    expect(facts.subscriptionCreated).toBeNull();
    expect(facts.subscriptionStatus).toBeNull();
  });
});

describe('familyDecidedState', () => {
  const cases: Array<[string, Partial<SessionFacts>, Partial<FamilyFacts> | null, string]> = [
    ['paid with no family to read', {}, null, 'receipt'],
    [
      'free plan, live subscription, no grant yet',
      {},
      { planTier: 'free', grantLanded: false },
      'pending',
    ],
    ['free plan after a grant landed', {}, { planTier: 'free', grantLanded: true }, 'receipt'],
    [
      'free plan with a canceled subscription',
      { subscriptionStatus: 'canceled' },
      { planTier: 'free', grantLanded: false },
      'receipt',
    ],
    [
      'a refused price on a free family',
      {},
      { planTier: 'free', grantLanded: false, purchaseRefused: true },
      'under_review',
    ],
    ['a refused price on a paying family', {}, { purchaseRefused: true }, 'under_review'],
    ['the same plan paid twice', {}, { priorTier: 'plus' }, 'under_review'],
    [
      'Plus, then an overlapping Max',
      { tier: 'family' },
      { planTier: 'family', priorTier: 'plus' },
      'under_review',
    ],
    ['the plan moved off this tier', {}, { planTier: 'family' }, 'receipt'],
    ['prior free and a payer with a thread', {}, {}, 'plan_active'],
    ['prior free and a payer with no thread', {}, { payerHasThread: false }, 'new_visitor'],
    ['prior free and no payer', {}, { payerId: null, payerHasThread: false }, 'new_visitor'],
  ];

  it.each(cases)('%s', (_name, sessionOver, familyOver, expected) => {
    const facts = familyOver === null ? null : family(familyOver);
    expect(familyDecidedState(session(sessionOver), facts)).toBe(expected);
  });

  it('never selects the states no flow makes true today', () => {
    const plans = ['free', 'plus', 'family'] as const;
    const seen = new Set<string>();
    for (const planTier of plans) {
      for (const priorTier of plans) {
        for (const tier of ['plus', 'family'] as const) {
          for (const purchaseRefused of [false, true]) {
            for (const grantLanded of [false, true]) {
              for (const payerHasThread of [false, true]) {
                seen.add(
                  familyDecidedState(
                    session({ tier }),
                    family({ planTier, priorTier, purchaseRefused, grantLanded, payerHasThread }),
                  ),
                );
              }
            }
          }
        }
      }
    }
    expect([...seen].sort()).toEqual([
      'new_visitor',
      'pending',
      'plan_active',
      'receipt',
      'under_review',
    ]);
  });
});
