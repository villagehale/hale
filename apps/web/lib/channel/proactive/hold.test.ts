import { describe, expect, it } from 'vitest';
import { type OpenCandidate, planHourlyReview } from './hold';

const TZ = 'America/New_York';
/** Thursday 19:00 in the family's zone. */
const NOW = new Date('2026-10-08T23:00:00.000Z');
const EARLIER = '2026-10-08T22:00:00.000Z';

function item(over: Partial<OpenCandidate> & Pick<OpenCandidate, 'id' | 'status'>): OpenCandidate {
  return {
    parentUserId: 'parent-1',
    kind: 'nudge',
    what: 'Saturday farmers market',
    why: 'a nearby listing',
    decision: 'hold',
    sourceUrl: 'https://example.test/market',
    worthlessAfter: null,
    parentRequested: false,
    holdUntil: null,
    reason: 'no window yet',
    decidedAt: EARLIER,
    createdAt: '2026-10-08T21:00:00.000Z',
    ...over,
  };
}

describe('planHourlyReview', () => {
  it('skips a hold whose clock time has not arrived', () => {
    const plan = planHourlyReview({
      items: [item({ id: 'later', status: 'held', holdUntil: '2026-10-09T13:00:00.000Z' })],
      now: NOW,
      timeZone: TZ,
      externalSignal: false,
    });
    expect(plan.skipModel).toBe(true);
    expect(plan.candidates).toEqual([]);
    expect(plan.priorDecisions).toEqual([
      {
        id: 'later',
        parentUserId: 'parent-1',
        action: 'held',
        at: EARLIER,
        reason: 'no window yet',
        holdUntil: '2026-10-09T13:00:00.000Z',
      },
    ]);
  });

  it('hands back a hold whose clock time has passed', () => {
    const plan = planHourlyReview({
      items: [item({ id: 'due', status: 'held', holdUntil: '2026-10-08T22:30:00.000Z' })],
      now: NOW,
      timeZone: TZ,
      externalSignal: false,
    });
    expect(plan.skipModel).toBe(false);
    expect(plan.candidates.map((candidate) => candidate.id)).toEqual(['due']);
  });

  it('does not call the model again the same local day when nothing new arrived', () => {
    const plan = planHourlyReview({
      items: [item({ id: 'open', status: 'held', holdUntil: null })],
      now: NOW,
      timeZone: TZ,
      externalSignal: false,
    });
    expect(plan.skipModel).toBe(true);
    expect(plan.candidates).toEqual([]);
  });

  it('reopens a clock-less hold the next local day', () => {
    const plan = planHourlyReview({
      items: [item({ id: 'open', status: 'held', holdUntil: null })],
      now: new Date('2026-10-09T14:00:00.000Z'),
      timeZone: TZ,
      externalSignal: false,
    });
    expect(plan.skipModel).toBe(false);
    expect(plan.candidates.map((candidate) => candidate.id)).toEqual(['open']);
  });

  it('reopens a clock-less hold when a parent reply or a calendar change arrived', () => {
    const plan = planHourlyReview({
      items: [item({ id: 'open', status: 'held', holdUntil: null })],
      now: NOW,
      timeZone: TZ,
      externalSignal: true,
    });
    expect(plan.candidates.map((candidate) => candidate.id)).toEqual(['open']);
    expect(plan.priorDecisions[0]?.reason).toBe('no window yet');
  });

  it('treats a newly queued candidate as a signal and leaves a future hold out', () => {
    const plan = planHourlyReview({
      items: [
        item({ id: 'open', status: 'held', holdUntil: null }),
        item({ id: 'fresh', status: 'queued', holdUntil: null, reason: null, decidedAt: null }),
        item({ id: 'later', status: 'held', holdUntil: '2026-10-09T13:00:00.000Z' }),
      ],
      now: NOW,
      timeZone: TZ,
      externalSignal: false,
    });
    expect(plan.skipModel).toBe(false);
    expect(plan.candidates.map((candidate) => candidate.id)).toEqual(['fresh', 'open']);
    expect(plan.priorDecisions.map((decision) => decision.id)).toEqual(['open', 'later']);
  });
  it('reopens a hold the code made after a send_now on a signal, not on the day turning', () => {
    const paused = item({
      id: 'paused',
      status: 'held',
      decision: 'send_now',
      reason: 'line_health',
      holdUntil: null,
    });
    const nextDay = new Date('2026-10-09T14:00:00.000Z');
    expect(
      planHourlyReview({ items: [paused], now: nextDay, timeZone: TZ, externalSignal: false }),
    ).toMatchObject({ skipModel: true, candidates: [] });
    expect(
      planHourlyReview({ items: [paused], now: nextDay, timeZone: TZ, externalSignal: true })
        .candidates,
    ).toMatchObject([{ id: 'paused' }]);
  });

  it('offers a held-open item the parent asked for at the next review, the same day, with nothing new', () => {
    const plan = planHourlyReview({
      items: [
        item({ id: 'asked', status: 'held', holdUntil: null, parentRequested: true }),
        item({ id: 'open', status: 'held', holdUntil: null }),
      ],
      now: NOW,
      timeZone: TZ,
      externalSignal: false,
    });
    expect(plan.skipModel).toBe(false);
    expect(plan.candidates.map((candidate) => candidate.id)).toEqual(['asked']);
  });

  it('does not let a re-held asked-for item keep yesterday’s other hold on today’s date', () => {
    const plan = planHourlyReview({
      items: [
        item({ id: 'asked', status: 'held', holdUntil: null, parentRequested: true }),
        item({
          id: 'open',
          status: 'held',
          holdUntil: null,
          decidedAt: '2026-10-07T22:00:00.000Z',
        }),
      ],
      now: NOW,
      timeZone: TZ,
      externalSignal: false,
    });
    expect(plan.skipModel).toBe(false);
    expect(plan.candidates.map((candidate) => candidate.id)).toEqual(['asked', 'open']);
  });
});
