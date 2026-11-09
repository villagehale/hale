import { describe, expect, it } from 'vitest';
import { type PlanReadOffer, signupPlanReadUserMessage, toPlanReading } from './reader';

const OFFER: PlanReadOffer = {
  status: 'pending',
  opensAt: new Date('2026-12-01T12:00:00.000Z'),
  approvedPriceCents: null,
  plan: null,
  sessions: [
    {
      id: 'sat-0900',
      label: 'Sat 9:00',
      startsAt: '2027-01-09T14:00:00.000Z',
      endsAt: '2027-01-09T14:45:00.000Z',
      full: false,
      priceCents: 9800,
    },
    {
      id: 'sun-1000',
      label: 'Sun 10:00',
      startsAt: '2027-01-10T15:00:00.000Z',
      endsAt: '2027-01-10T15:45:00.000Z',
      full: false,
      priceCents: 9800,
    },
  ],
};

const raw = (over: Partial<Parameters<typeof toPlanReading>[0]> = {}) => ({
  reason: 'r',
  verdict: 'approve' as const,
  choiceIds: ['sun-1000', 'sat-0900'],
  maxPriceCents: 10000,
  waiverAccepted: false,
  question: null,
  ...over,
});

describe('toPlanReading', () => {
  it('keeps a ranked approval of sessions the offer has', () => {
    expect(toPlanReading(raw(), OFFER)).toEqual({
      verdict: 'approve',
      choiceIds: ['sun-1000', 'sat-0900'],
      maxPriceCents: 10000,
      waiverAccepted: false,
    });
  });

  it.each([
    ['an invented session', { choiceIds: ['mon-0800'] }],
    ['a repeated session', { choiceIds: ['sat-0900', 'sat-0900'] }],
    ['no session', { choiceIds: [] }],
    ['no price', { maxPriceCents: null }],
    ['a zero price', { maxPriceCents: 0 }],
  ])('an approval with %s is never a plan: the question goes back, or nothing', (_, over) => {
    expect(toPlanReading(raw(over), OFFER)).toBeNull();
    expect(toPlanReading(raw({ ...over, question: 'Which day?' }), OFFER)).toEqual({
      verdict: 'unclear',
      question: 'Which day?',
    });
  });

  it('an approval of a plan already approved changes nothing', () => {
    const planned: PlanReadOffer = {
      ...OFFER,
      status: 'planned',
      plan: { choiceIds: ['sat-0900'], maxPriceCents: 9800, waiverAccepted: false },
    };
    expect(toPlanReading(raw(), planned)).toEqual({ verdict: 'unrelated' });
    expect(toPlanReading(raw({ verdict: 'take_back' }), planned)).toEqual({
      verdict: 'take_back',
    });
  });

  it('a question carrying a link is not asked', () => {
    expect(
      toPlanReading(raw({ verdict: 'unclear', question: 'See https://x.test ?' }), OFFER),
    ).toBeNull();
  });

  it('the model sees the sessions and the plan, and nothing about the child', () => {
    const message = JSON.parse(signupPlanReadUserMessage({ text: 'yes', offer: OFFER }));
    expect(message.offer.sessions.map((s: { id: string }) => s.id)).toEqual([
      'sat-0900',
      'sun-1000',
    ]);
    expect(message.offer.opensAt).toBe('2026-12-01T12:00:00.000Z');
    expect(Object.keys(message.offer)).not.toContain('childId');
  });
});
