import { describe, expect, it, vi } from 'vitest';
import type { SignupIdentity } from '../types';
import type { SignupTermsApproved } from '../terms/types';
import { browserUseApi } from './client';
import type { BrowserUseEngineDeps } from './engine';
import {
  type BrowserUsePlanInput,
  type PlanBinding,
  type PlanConfirmedFacts,
  type PlanEngineStep,
  runBrowserUsePlanSignup,
} from './plan-engine';

// Fake Browser Use responses only. No request leaves the process.
const NOW = new Date('2026-12-01T11:55:00.000Z');
const URL_ = 'https://register.example-rec.test/Clients/BookMe4LandingPages/CoursesLandingPage';
const LIVE = 'https://live.browser-use.com/s/fixture-live-view-token';
const IDENTITY: SignupIdentity = {
  childFirstName: 'Ada',
  childLastName: 'Lovelace',
  childDob: '2022-04-01',
  parentFirstName: 'Grace',
  parentEmail: 'grace@example.test',
  postalCode: 'A1A1A1',
  teenager: false,
};

const CART_READ = {
  provider_course_id: '283993',
  session_label: 'Get Ready Public Speaking',
  session_date: '2026-12-05',
  session_time: '09:30',
  participant_first_name: 'Ada',
  line_count: 1,
  quantity: 1,
};

const CHECKOUT = {
  outcome: 'reached_checkout',
  detail: 'none',
  choice_index: 0,
  checkout_url: 'https://register.example-rec.test/Checkout',
  cart_total_cents: 8488,
  cart_currency: 'cad',
  hold_minutes: 5,
  saved_card_on_file: true,
  security_code_required: false,
  payment_details_entered: false,
  cart_read: CART_READ,
};

const REVIEW = {
  outcome: 'ready_to_place',
  detail: 'none',
  total_cents: 8488,
  currency: 'cad',
  tax_cents: 0,
  fees_cents: 0,
  saved_card_selected: true,
  order_placed: false,
  cart_read: CART_READ,
};

const PAID = {
  outcome: 'paid',
  detail: 'none',
  confirmation_number: 'R-55120',
  amount_charged_cents: 8488,
};

const FREE_CHECKOUT = {
  ...CHECKOUT,
  cart_total_cents: 0,
  cart_currency: null,
  saved_card_on_file: false,
};

const FREE_REVIEW = {
  ...REVIEW,
  total_cents: 0,
  currency: null,
  saved_card_selected: false,
};

const FREE_PLACED = {
  outcome: 'paid',
  detail: 'none',
  confirmation_number: 'R-777',
  amount_charged_cents: null,
};

const approved = (over: Partial<SignupTermsApproved> = {}): SignupTermsApproved => ({
  v: 1,
  sessions: [
    {
      sessionId: 's-1',
      program: { courseIds: ['283993'], name: 'Get Ready Public Speaking' },
      startsAt: '2026-12-05T09:30:00',
      sharesDate: false,
      amount: { kind: 'exact', cents: [8488], currency: 'cad', plusTax: null, limitCents: null },
    },
  ],
  quantity: 1,
  maxCents: 8488,
  prerequisiteConfirmed: null,
  countsAgainstSeason: false,
  seasonKey: null,
  hold: null,
  ...over,
});

const FREE_APPROVED = approved({
  maxCents: 0,
  sessions: [
    {
      sessionId: 's-1',
      program: { courseIds: ['283993'], name: 'Get Ready Public Speaking' },
      startsAt: '2026-12-05T09:30:00',
      sharesDate: false,
      amount: { kind: 'free' },
    },
  ],
});

type Outputs = {
  plan: Record<string, unknown>;
  review?: Record<string, unknown>;
  payment?: Record<string, unknown>;
};

function harness(outputs: Outputs, opts: { browserId?: string | null } = {}) {
  const log: { method: string; path: string; body: Record<string, unknown> }[] = [];
  const skillOf = new Map<string, string>();
  let runs = 0;
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    const parsed = new URL(url);
    const method = init.method ?? 'GET';
    const path = `${parsed.pathname.replace('/api/v4', '')}${parsed.search}`;
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : {};
    log.push({ method, path, body });
    if (method === 'POST' && path === '/runs') {
      runs += 1;
      skillOf.set(`run-${runs}`, String(body.task).split('\n')[0] ?? '');
      return Response.json({ id: `run-${runs}`, sessionId: 'bu-session-1' });
    }
    const run = /^\/runs\/(run-\d)/.exec(path)?.[1];
    if (run && path.endsWith('/status')) return Response.json({ status: 'completed' });
    if (run && path.includes('/events')) {
      return Response.json({
        events: [
          {
            id: 1,
            type: 'browser.ready',
            data: {
              live_view_url: LIVE,
              browser_session_id: opts.browserId === undefined ? 'browser-1' : opts.browserId,
            },
          },
        ],
        nextAfter: null,
      });
    }
    if (run) {
      const skill = skillOf.get(run) ?? '';
      const output = skill.includes('plan-signup')
        ? outputs.plan
        : skill.includes('review')
          ? (outputs.review ?? REVIEW)
          : outputs.payment;
      return Response.json({
        id: run,
        status: 'completed',
        sessionId: 'bu-session-1',
        output,
        error: null,
        totalCostUsd: '0.0100',
      });
    }
    if (method === 'PATCH' && path.startsWith('/browsers/')) return Response.json({});
    if (path === '/sessions/bu-session-1/cost') {
      return Response.json({ sessionId: 'bu-session-1', totalCostUsd: '0.090000' });
    }
    throw new Error(`unexpected ${method} ${path}`);
  });
  let clock = NOW.getTime();
  const deps: BrowserUseEngineDeps = {
    api: browserUseApi({ apiKey: 'test-key', fetch: fetchImpl }),
    seeder: null,
    loadTask: async (skill) => `# skill ${skill}`,
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => new Date(clock),
  };
  const created = () =>
    log.filter((row) => row.method === 'POST' && row.path === '/runs').map((row) => row.body);
  const skills = () => created().map((body) => String(body.task).split('\n')[0]);
  return { deps, skills, created };
}

const binding = (over: Partial<PlanBinding> = {}): PlanBinding => ({
  approved: approved(),
  childFirstName: 'Ada',
  siblingFirstNames: [],
  timeZone: 'America/Toronto',
  freeCheckoutEnabled: false,
  priorChargeNow: async () => false,
  ...over,
});

function input(over: Partial<BrowserUsePlanInput> = {}) {
  const steps: PlanEngineStep[] = [];
  const value: BrowserUsePlanInput = {
    mode: 'auto',
    correlationId: 'offer-fixture',
    registrationUrl: URL_,
    identity: IDENTITY,
    fieldsAllowed: ['child_first_name', 'child_last_name', 'child_dob', 'session'],
    choices: [
      {
        label: 'Sat 9:30',
        startsAt: '2026-12-05T09:30:00',
        endsAt: '2026-12-05T10:30:00',
      },
    ],
    maxPriceCents: 8488,
    waiverAccepted: false,
    paymentEnabled: true,
    providerSession: { storageState: { cookies: [], origins: [] }, browserUseProfileId: 'p-1' },
    onProfileCreated: async () => undefined,
    proxyCountryCode: 'ca',
    credentials: null,
    accountCreate: false,
    joinWaitlist: false,
    askedStart: null,
    checkSpendingCap: async () => ({ ok: true, reason: 'within' }),
    stillAuthorized: async () => true,
    onStep: async (step) => {
      steps.push(step);
    },
    resume: null,
    waitUntil: new Date(NOW.getTime() + 10 * 60_000),
    onCheckpoint: async () => true,
    binding: binding(),
    ...over,
  };
  return { value, steps };
}

const PAYMENT_SKILL = '# skill browser-use-saved-card-payment';

describe('a bound plan run', () => {
  it('pays once on a cart that matches (positive control)', async () => {
    const h = harness({ plan: CHECKOUT, payment: PAID });
    const { value, steps } = input();
    const result = await runBrowserUsePlanSignup(value, h.deps);
    expect(result.outcome).toBe('completed');
    expect(result.outcome === 'completed' && result.charged).toEqual({ cents: 8488 });
    expect(h.skills().filter((skill) => skill === PAYMENT_SKILL)).toHaveLength(1);
    expect(steps.filter((step) => step.step === 'cart_check')).toEqual([
      { step: 'cart_check', stage: 'cart', differences: [], ok: true },
      { step: 'cart_check', stage: 'final', differences: [], ok: true },
    ]);
  });

  it('a confirmed run with no browser id still reaches the receipt hook', async () => {
    const h = harness({ plan: CHECKOUT, payment: PAID }, { browserId: null });
    const onConfirmed = vi.fn(async (_facts: PlanConfirmedFacts) => undefined);
    const { value } = input({ onConfirmed });
    const result = await runBrowserUsePlanSignup(value, h.deps);
    expect(result.outcome).toBe('completed');
    expect(onConfirmed).toHaveBeenCalledTimes(1);
    expect(onConfirmed.mock.calls[0]?.[0]).toMatchObject({
      browserId: null,
      confirmationNumber: 'R-55120',
      waitUntil: value.waitUntil,
    });
  });

  it('sends the extended schema and the cart-read addendum only on a bound run', async () => {
    const h = harness({ plan: CHECKOUT, payment: PAID });
    const { value } = input();
    await runBrowserUsePlanSignup(value, h.deps);
    const first = h.created()[0] as { task: string; outputSchema: { properties: object } };
    expect(first.task).toContain('# skill browser-use-cart-read');
    expect(Object.keys(first.outputSchema.properties)).toContain('cart_read');
  });

  it.each([
    ['a non-resident price', { plan: { ...CHECKOUT, cart_total_cents: 9760 } }, ['price']],
    [
      'a changed session',
      { plan: { ...CHECKOUT, cart_read: { ...CART_READ, session_date: '2026-12-12' } } },
      ['session'],
    ],
    [
      'a sibling in the cart',
      { plan: { ...CHECKOUT, cart_read: { ...CART_READ, participant_first_name: 'Ben' } } },
      ['kid'],
    ],
    [
      'quantity 2',
      { plan: { ...CHECKOUT, cart_read: { ...CART_READ, quantity: 2 } } },
      ['quantity'],
    ],
    ['a cart it could not read', { plan: { ...CHECKOUT, cart_read: null } }, ['unread']],
  ])('%s at the cart creates no review and no payment', async (_name, outputs, differences) => {
    const h = harness(outputs as Outputs);
    const { value } = input();
    const result = await runBrowserUsePlanSignup(value, h.deps);
    expect(h.skills()).toEqual(['# skill browser-use-plan-signup']);
    expect(result.outcome).toBe('needs_human');
    if (result.outcome === 'checkpointed') return;
    expect(result.detail).toBe('cart_mismatch');
    expect(result.charged).toBe('nothing');
    expect(result.cartDifferences).toEqual(differences);
    expect(result.liveViewUrl).toBe(LIVE);
  });

  it('an extra fee on the final page creates no payment run', async () => {
    const h = harness({
      plan: CHECKOUT,
      review: { ...REVIEW, total_cents: 9488, fees_cents: 1000 },
      payment: PAID,
    });
    const { value } = input({
      binding: binding({
        approved: approved({
          maxCents: 9488,
          sessions: [
            {
              ...(approved().sessions[0] as SignupTermsApproved['sessions'][number]),
              amount: {
                kind: 'exact',
                cents: [8488],
                currency: 'cad',
                plusTax: { kind: 'ceiling', basisPoints: 1500 },
                limitCents: null,
              },
            },
          ],
        }),
      }),
      maxPriceCents: 9761,
    });
    const result = await runBrowserUsePlanSignup(value, h.deps);
    expect(h.skills()).not.toContain(PAYMENT_SKILL);
    if (result.outcome === 'checkpointed') throw new Error('checkpointed');
    expect(result.detail).toBe('cart_mismatch');
    expect(result.charged).toBe('nothing');
    expect(result.cartDifferences).toEqual(['fees']);
  });

  it('a placed order with a differing cart ends unknown, never nothing', async () => {
    const h = harness({
      plan: CHECKOUT,
      review: { ...REVIEW, total_cents: 9760, order_placed: true },
    });
    const { value } = input();
    const result = await runBrowserUsePlanSignup(value, h.deps);
    expect(h.skills()).not.toContain(PAYMENT_SKILL);
    if (result.outcome === 'checkpointed') throw new Error('checkpointed');
    expect(result.detail).toBe('review_placed_order');
    expect(result.charged).toBe('unknown');
  });

  it('a held plan stops at a matching cart: no review, no payment', async () => {
    const h = harness({ plan: CHECKOUT, payment: PAID });
    const { value } = input({
      binding: binding({ approved: approved({ hold: 'age_unconfirmed' }) }),
    });
    const result = await runBrowserUsePlanSignup(value, h.deps);
    expect(h.skills()).toEqual(['# skill browser-use-plan-signup']);
    if (result.outcome === 'checkpointed') throw new Error('checkpointed');
    expect(result.outcome).toBe('needs_human');
    expect(result.detail).toBe('age_unconfirmed');
    expect(result.charged).toBe('nothing');
    expect(result.liveViewUrl).toBe(LIVE);
  });

  describe('an earlier run that may have charged, read again at the run', () => {
    it('found at the cart: stops there, before the review and the card', async () => {
      const h = harness({ plan: CHECKOUT, payment: PAID });
      const { value } = input({ binding: binding({ priorChargeNow: async () => true }) });
      const result = await runBrowserUsePlanSignup(value, h.deps);
      expect(h.skills()).toEqual(['# skill browser-use-plan-signup']);
      if (result.outcome === 'checkpointed') throw new Error('checkpointed');
      expect(result.outcome).toBe('needs_human');
      expect(result.detail).toBe('prior_charge_unknown');
      expect(result.charged).toBe('nothing');
      expect(result.liveViewUrl).toBe(LIVE);
    });

    it('found after the review, just before the card: no payment run', async () => {
      const h = harness({ plan: CHECKOUT, payment: PAID });
      const answers = [false, true];
      const priorChargeNow = vi.fn(async () => answers.shift() ?? true);
      const { value } = input({ binding: binding({ priorChargeNow }) });
      const result = await runBrowserUsePlanSignup(value, h.deps);
      expect(priorChargeNow).toHaveBeenCalledTimes(2);
      expect(h.skills()).toEqual([
        '# skill browser-use-plan-signup',
        '# skill browser-use-checkout-review',
      ]);
      if (result.outcome === 'checkpointed') throw new Error('checkpointed');
      expect(result.detail).toBe('prior_charge_unknown');
      expect(result.charged).toBe('nothing');
    });

    it('none found: the run pays (positive control)', async () => {
      const h = harness({ plan: CHECKOUT, payment: PAID });
      const priorChargeNow = vi.fn(async () => false);
      const { value } = input({ binding: binding({ priorChargeNow }) });
      const result = await runBrowserUsePlanSignup(value, h.deps);
      expect(result.outcome).toBe('completed');
      expect(priorChargeNow).toHaveBeenCalledTimes(2);
    });
  });

  describe('a session the site listed with no end time', () => {
    const noEnd = [
      { label: 'Sun 10:00', startsAt: '2026-12-05T09:30:00', endsAt: '2026-12-05T09:30:00' },
    ];
    const factsOf = (task: unknown) => {
      const text = String(task);
      const at = text.indexOf('"choices"');
      return text.slice(at, at + 200);
    };

    it('a bound run is told the end is not known', async () => {
      const h = harness({ plan: CHECKOUT, payment: PAID });
      const { value } = input({ choices: noEnd });
      await runBrowserUsePlanSignup(value, h.deps);
      const facts = factsOf((h.created()[0] as { task: unknown }).task);
      expect(facts).toContain('"ends_at": null');
      expect(facts).not.toContain('"ends_at": "2026-12-05T09:30:00"');
    });

    it('an unbound run sends the times it always sent', async () => {
      const h = harness({
        plan: { ...CHECKOUT, cart_read: undefined },
        review: { ...REVIEW, cart_read: undefined },
        payment: PAID,
      });
      const { value } = input({ choices: noEnd, binding: null });
      await runBrowserUsePlanSignup(value, h.deps);
      expect(factsOf((h.created()[0] as { task: unknown }).task)).toContain(
        '"ends_at": "2026-12-05T09:30:00"',
      );
    });
  });

  it('with no binding the run is the run of today', async () => {
    const h = harness({
      plan: { ...CHECKOUT, cart_total_cents: 9760, cart_read: undefined },
      review: { ...REVIEW, total_cents: 9760, cart_read: undefined },
      payment: { ...PAID, amount_charged_cents: 9760 },
    });
    const { value, steps } = input({ binding: null, maxPriceCents: 10_000 });
    const result = await runBrowserUsePlanSignup(value, h.deps);
    expect(result.outcome).toBe('completed');
    expect(steps.some((step) => step.step === 'cart_check')).toBe(false);
    const first = h.created()[0] as { task: string; outputSchema: { properties: object } };
    expect(first.task).toBe(first.task.replace('# skill browser-use-cart-read', '<never there>'));
    expect(Object.keys(first.outputSchema.properties)).not.toContain('cart_read');
  });
});

describe('the free path', () => {
  const free = (over: Partial<PlanBinding> = {}) =>
    binding({ approved: FREE_APPROVED, freeCheckoutEnabled: true, ...over });

  it('runs end to end with a confirmation and charges nothing', async () => {
    const h = harness({ plan: FREE_CHECKOUT, review: FREE_REVIEW, payment: FREE_PLACED });
    const { value } = input({ binding: free(), maxPriceCents: 0, paymentEnabled: false });
    const result = await runBrowserUsePlanSignup(value, h.deps);
    expect(h.skills()).toEqual([
      '# skill browser-use-plan-signup',
      '# skill browser-use-free-review',
      '# skill browser-use-free-checkout',
    ]);
    if (result.outcome === 'checkpointed') throw new Error('checkpointed');
    expect(result.outcome).toBe('completed');
    expect(result.confirmationNumber).toBe('R-777');
    expect(result.charged).toEqual({ cents: 0 });
  });

  it('a $1 cart on a free binding stops', async () => {
    const h = harness({
      plan: { ...FREE_CHECKOUT, cart_total_cents: 100, cart_currency: 'cad' },
      payment: FREE_PLACED,
    });
    const { value } = input({ binding: free(), maxPriceCents: 0 });
    const result = await runBrowserUsePlanSignup(value, h.deps);
    expect(h.skills()).toEqual(['# skill browser-use-plan-signup']);
    if (result.outcome === 'checkpointed') throw new Error('checkpointed');
    expect(result.detail).toBe('cart_mismatch');
    expect(result.cartDifferences).toEqual(['price']);
    expect(result.charged).toBe('nothing');
  });

  it('a final page that is not $0 stops before the place-order run', async () => {
    const h = harness({
      plan: FREE_CHECKOUT,
      review: { ...FREE_REVIEW, total_cents: 500, currency: 'cad' },
      payment: FREE_PLACED,
    });
    const { value } = input({ binding: free(), maxPriceCents: 0 });
    const result = await runBrowserUsePlanSignup(value, h.deps);
    expect(h.skills()).not.toContain('# skill browser-use-free-checkout');
    if (result.outcome === 'checkpointed') throw new Error('checkpointed');
    expect(result.outcome).toBe('needs_human');
    expect(result.charged).toBe('nothing');
  });

  it('no confirmation number is never completed', async () => {
    const h = harness({
      plan: FREE_CHECKOUT,
      review: FREE_REVIEW,
      payment: { ...FREE_PLACED, confirmation_number: null },
    });
    const { value } = input({ binding: free(), maxPriceCents: 0 });
    const result = await runBrowserUsePlanSignup(value, h.deps);
    if (result.outcome === 'checkpointed') throw new Error('checkpointed');
    expect(result.outcome).toBe('needs_human');
    expect(result.detail).toBe('unconfirmed');
    expect(result.charged).toBe('unknown');
  });

  it('an order that charged more than zero is a mismatch', async () => {
    const h = harness({
      plan: FREE_CHECKOUT,
      review: FREE_REVIEW,
      payment: { ...FREE_PLACED, amount_charged_cents: 500 },
    });
    const { value } = input({ binding: free(), maxPriceCents: 0 });
    const result = await runBrowserUsePlanSignup(value, h.deps);
    if (result.outcome === 'checkpointed') throw new Error('checkpointed');
    expect(result.detail).toBe('charge_mismatch');
    expect(result.charged).toEqual({ cents: 500 });
  });

  it('the free switch off stops at payment_off, whatever the payment switch says', async () => {
    const h = harness({ plan: FREE_CHECKOUT, review: FREE_REVIEW, payment: FREE_PLACED });
    const { value } = input({
      binding: free({ freeCheckoutEnabled: false }),
      maxPriceCents: 0,
      paymentEnabled: true,
    });
    const result = await runBrowserUsePlanSignup(value, h.deps);
    expect(h.skills()).toEqual(['# skill browser-use-plan-signup']);
    if (result.outcome === 'checkpointed') throw new Error('checkpointed');
    expect(result.detail).toBe('payment_off');
  });

  describe('a class free for residents and paid for others', () => {
    const pair = (over: Partial<PlanBinding> = {}) =>
      binding({
        approved: approved({
          maxCents: 4000,
          sessions: [
            {
              ...(approved().sessions[0] as SignupTermsApproved['sessions'][number]),
              amount: {
                kind: 'exact',
                cents: [0, 4000],
                currency: 'cad',
                plusTax: null,
                limitCents: null,
              },
            },
          ],
        }),
        freeCheckoutEnabled: true,
        ...over,
      });

    it('a $0 cart takes the free path, with no card and no currency', async () => {
      const h = harness({ plan: FREE_CHECKOUT, review: FREE_REVIEW, payment: FREE_PLACED });
      const { value } = input({ binding: pair(), maxPriceCents: 4000, paymentEnabled: false });
      const result = await runBrowserUsePlanSignup(value, h.deps);
      expect(h.skills()).toEqual([
        '# skill browser-use-plan-signup',
        '# skill browser-use-free-review',
        '# skill browser-use-free-checkout',
      ]);
      if (result.outcome === 'checkpointed') throw new Error('checkpointed');
      expect(result.outcome).toBe('completed');
      expect(result.charged).toEqual({ cents: 0 });
    });

    it('the paid rate is a paid checkout, and the free switch does not arm it', async () => {
      const h = harness({
        plan: { ...CHECKOUT, cart_total_cents: 4000 },
        review: { ...REVIEW, total_cents: 4000 },
        payment: { ...PAID, amount_charged_cents: 4000 },
      });
      const { value } = input({ binding: pair(), maxPriceCents: 4000, paymentEnabled: false });
      const result = await runBrowserUsePlanSignup(value, h.deps);
      expect(h.skills()).toEqual(['# skill browser-use-plan-signup']);
      if (result.outcome === 'checkpointed') throw new Error('checkpointed');
      expect(result.detail).toBe('payment_off');
      expect(result.charged).toBe('nothing');
    });

    it('the paid rate pays when the payment switch is on', async () => {
      const h = harness({
        plan: { ...CHECKOUT, cart_total_cents: 4000 },
        review: { ...REVIEW, total_cents: 4000 },
        payment: { ...PAID, amount_charged_cents: 4000 },
      });
      const { value } = input({ binding: pair(), maxPriceCents: 4000, paymentEnabled: true });
      const result = await runBrowserUsePlanSignup(value, h.deps);
      expect(result.outcome).toBe('completed');
      expect(result.outcome === 'completed' && result.charged).toEqual({ cents: 4000 });
    });
  });

  it('a paid binding never takes the free path on a zero cart', async () => {
    const h = harness({ plan: { ...CHECKOUT, cart_total_cents: 0 }, payment: PAID });
    const { value } = input();
    const result = await runBrowserUsePlanSignup(value, h.deps);
    expect(h.skills()).toEqual(['# skill browser-use-plan-signup']);
    if (result.outcome === 'checkpointed') throw new Error('checkpointed');
    expect(result.detail).toBe('cart_mismatch');
    expect(result.cartDifferences).toEqual(['price']);
  });
});
