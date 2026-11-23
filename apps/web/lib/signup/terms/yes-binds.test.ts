import { describe, expect, it } from 'vitest';
import { type PlanReadOffer, type PlanReading, toPlanReading } from '../plan/reader';
import { planReadTerms } from './ask';
import { type BindResult, bindApproval } from './bind';
import type { SignupTermsShown } from './types';

type Session = SignupTermsShown['sessions'][number];

const session = (
  sessionId: string,
  cents: number | null,
  tax: Session['tax'] = 'included',
): Session => ({
  sessionId,
  rates: cents === null ? [] : [{ rate: 'resident', cents }],
  tax,
  source: 'course_model',
});

const shownWith = (...sessions: Session[]): SignupTermsShown => ({
  v: 1,
  read: 'course_model',
  program: { courseIds: ['c-1'], name: 'Parent and Tot Swim' },
  residency: 'resident',
  age: { fit: 'in_band', band: '4 to 6', rule: null },
  prerequisite: { required: 'no', quote: null },
  refund: null,
  currency: 'cad',
  countsAgainstSeason: false,
  priorChargeUnknown: false,
  sessions,
});

const SESSION_ROWS = ['s-1', 's-2'].map((id, index) => ({
  id,
  label: `Sat ${9 + index}:30`,
  startsAt: `2026-03-2${index + 1}T09:30:00`,
  endsAt: `2026-03-2${index + 1}T10:30:00`,
  full: false,
  priceCents: null,
}));

/** The model's reading of a yes to `choiceIds`, as the terms tool returns it. */
const modelYes = (text: string, maxPriceCents: number | null, choiceIds = ['s-1']) => ({
  reason: 'r',
  said: text,
  named: null,
  verdict: 'approve' as const,
  choiceIds,
  maxPriceCents,
  waiverSaid: null,
  waiverAccepted: false,
  question: null,
  prerequisiteSaid: null,
  prerequisiteMet: null,
});

function run(
  shown: SignupTermsShown,
  text: string,
  maxPriceCents: number | null,
  choiceIds = ['s-1'],
): { reading: PlanReading | null; bound: BindResult | null } {
  const offer: PlanReadOffer = {
    status: 'pending',
    activity: 'Parent and Tot Swim',
    host: 'register.example-rec.test',
    opensAt: new Date('2026-02-24T11:30:00.000Z'),
    approvedPriceCents: null,
    plan: null,
    asksWaiver: false,
    sessions: SESSION_ROWS,
    terms: planReadTerms(shown, { prerequisiteAsked: false }),
  };
  const reading = toPlanReading(modelYes(text, maxPriceCents, choiceIds), offer, text);
  if (reading?.verdict !== 'approve') return { reading, bound: null };
  const bound = bindApproval({
    shown,
    askedMessageId: 'm-1',
    sessions: SESSION_ROWS,
    activityLabel: 'Parent and Tot Swim',
    choiceIds: reading.choiceIds,
    ceilingCents: reading.ceilingCents ?? null,
    prerequisiteMet: reading.prerequisiteMet ?? null,
    ageFit: 'in_band',
    taxBound: { kind: 'rate', basisPoints: 1300 },
    timeZone: 'America/Toronto',
  });
  return { reading, bound };
}

const amountOf = (bound: BindResult | null, index = 0) =>
  bound?.kind === 'bound' ? bound.approved.sessions[index]?.amount : null;

const EXACT = (cents: number, plusTax: unknown = null) => ({
  kind: 'exact',
  cents: [cents],
  currency: 'cad',
  plusTax,
});

describe('what a yes to a stated price binds', () => {
  for (const [text, cents] of [
    ['yes please', 8488],
    ['sure, the 4pm one', 12000],
    ['yes for level 3', 12000],
  ] as const) {
    it(`binds the stated price and nothing else: ${text}`, () => {
      const { reading, bound } = run(shownWith(session('s-1', cents)), text, cents);
      expect(reading?.verdict).toBe('approve');
      expect(amountOf(bound)).toEqual(EXACT(cents));
      expect(bound?.kind === 'bound' && bound.approved.maxCents).toBe(cents);
    });
  }

  it('a plain yes to a plus-tax class binds the price and its tax (control)', () => {
    const { reading, bound } = run(shownWith(session('s-1', 12000, 'plus_tax')), 'yes', 12000);
    expect(reading?.verdict).toBe('approve');
    expect(amountOf(bound)).toEqual(EXACT(12000, { kind: 'rate', basisPoints: 1300 }));
  });

  it('the price said back on a plus-tax class asks: it could be a cap on the total', () => {
    const { reading, bound } = run(
      shownWith(session('s-1', 12000, 'plus_tax')),
      'yes, $120 is fine',
      12000,
    );
    expect(reading?.verdict).toBe('unclear');
    expect(bound).toBeNull();
  });

  it('"up to $80" on a class with two rates asks, although $80 is one of them', () => {
    const twoRates: Session = {
      ...session('s-1', 8000),
      rates: [
        { rate: 'resident', cents: 8000 },
        { rate: 'non_resident', cents: 12000 },
      ],
    };
    const { reading, bound } = run(
      { ...shownWith(twoRates), residency: 'unknown' },
      'yes, up to $80',
      12000,
    );
    expect(reading?.verdict).toBe('unclear');
    expect(bound).toBeNull();
  });

  it('money beside a two-session pick asks, although it is the price of one of them', () => {
    const shown = shownWith(session('s-1', 8000), session('s-2', 12000));
    const { reading, bound } = run(shown, 'yes both, $80', 12000, ['s-1', 's-2']);
    expect(reading?.verdict).toBe('unclear');
    expect(bound).toBeNull();
  });

  for (const text of ['yes, $84.88 is fine', 'oui, 84,88 $ ça va', '可以，84.88加币']) {
    it(`money in any format beside the yes asks, even the price itself: ${text}`, () => {
      const { reading, bound } = run(shownWith(session('s-1', 8488)), text, 8488);
      expect(reading?.verdict).toBe('unclear');
      expect(bound).toBeNull();
    });
  }

  for (const text of [
    'yes up to $100',
    'level 3 100 dollars max',
    'last year it was $40 so this is fine',
    'yes, as long as it is under 150 bucks',
  ]) {
    it(`asks and binds nothing on a class that costs 120: ${text}`, () => {
      const { reading, bound } = run(shownWith(session('s-1', 12000)), text, 12000);
      expect(reading).toMatchObject({ verdict: 'unclear', named: null });
      expect(reading?.verdict === 'unclear' && reading.question).toMatch(/stated price/);
      expect(bound).toBeNull();
    });
  }

  it('a figure the model took as the most, in no currency, asks and binds nothing', () => {
    const { reading, bound } = run(shownWith(session('s-1', 12000)), 'yes up to 100', 10000);
    expect(reading?.verdict).toBe('unclear');
    expect(bound).toBeNull();
  });

  it("a price stated for a session they did not pick is no echo of this one's", () => {
    const shown = shownWith(session('s-1', 8400), session('s-2', 12000));
    const { reading, bound } = run(shown, 'yes the second one, $84 max', 12000, ['s-2']);
    expect(reading?.verdict).toBe('unclear');
    expect(bound).toBeNull();
  });

  it('money on a free class asks', () => {
    const { reading } = run(shownWith(session('s-1', 0)), 'yes, up to $20', 0);
    expect(reading?.verdict).toBe('unclear');
  });

  it('a plain yes to a free class binds free (control)', () => {
    const { bound } = run(shownWith(session('s-1', 0)), 'yes', 0);
    expect(amountOf(bound)).toEqual({ kind: 'free' });
  });
});

describe('what a yes to a session with no stated price binds', () => {
  it('money they wrote sets the ceiling', () => {
    const { reading, bound } = run(shownWith(session('s-1', null)), 'yes up to $150', 15000);
    expect(reading?.verdict === 'approve' && reading.ceilingCents).toBe(15000);
    expect(amountOf(bound)).toEqual({ kind: 'ceiling', cents: 15000, currency: 'cad' });
  });

  it('a bare number sets no ceiling, and Hale asks for the amount', () => {
    const { reading, bound } = run(shownWith(session('s-1', null)), 'yes up to 150', 15000);
    expect(reading?.verdict === 'approve' && reading.ceilingCents).toBeNull();
    expect(bound).toEqual({ kind: 'clarify', reason: 'no_amount' });
  });

  it('two amounts set no ceiling, and Hale asks for the amount', () => {
    const { bound } = run(shownWith(session('s-1', null)), 'yes, $100 or $150', 15000);
    expect(bound).toEqual({ kind: 'clarify', reason: 'no_amount' });
  });

  it('money beside a pick of one priced and one unpriced session sets no ceiling', () => {
    const shown = shownWith(session('s-1', 12000), session('s-2', null));
    const { reading, bound } = run(shown, 'yes both, up to $120', 12000, ['s-1', 's-2']);
    expect(reading?.verdict).toBe('unclear');
    expect(bound).toBeNull();
  });

  it('a figure the parent never wrote sets no ceiling', () => {
    const { bound } = run(shownWith(session('s-1', null)), 'yes up to $150', 20000);
    expect(bound).toEqual({ kind: 'clarify', reason: 'no_amount' });
  });

  it('a stated price beside it does not stand in for the unpriced session', () => {
    const shown = shownWith(session('s-1', 12000), session('s-2', null));
    const { bound } = run(shown, 'yes both', 12000, ['s-1', 's-2']);
    expect(bound).toEqual({ kind: 'clarify', reason: 'no_amount' });
  });
});
