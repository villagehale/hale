import { describe, expect, it } from 'vitest';
import { type OpenCandidate, planHourlyReview } from './hold';

const NOW = new Date('2026-10-08T23:00:00.000Z');
const EARLIER = '2026-10-08T22:00:00.000Z';

function item(over: Partial<OpenCandidate> & Pick<OpenCandidate, 'id' | 'status'>): OpenCandidate {
  return {
    what: 'Saturday farmers market',
    why: 'a nearby listing',
    sourceUrl: 'https://example.test/market',
    worthlessAfter: null,
    parentRequested: false,
    dedupeKey: over.id,
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
      items: [
        item({
          id: 'later',
          status: 'held',
          holdUntil: '2026-10-09T13:00:00.000Z',
        }),
      ],
      now: NOW,
      timeZone: 'America/Toronto',
      externalSignal: false,
    });
    expect(plan.skipModel).toBe(true);
    expect(plan.candidates).toEqual([]);
    expect(plan.priorDecisions).toEqual([
      {
        id: 'later',
        action: 'held',
        at: EARLIER,
        reason: 'no window yet',
        holdUntil: '2026-10-09T13:00:00.000Z',
      },
    ]);
  });

  it('does not call the model again the same day when nothing new arrived', () => {
    const plan = planHourlyReview({
      items: [item({ id: 'open', status: 'held', holdUntil: null })],
      now: NOW,
      timeZone: 'America/Toronto',
      externalSignal: false,
    });
    expect(plan.skipModel).toBe(true);
    expect(plan.candidates).toEqual([]);
  });

  it('reopens a clock-less hold the next local day', () => {
    const plan = planHourlyReview({
      items: [item({ id: 'open', status: 'held', holdUntil: null })],
      now: new Date('2026-10-09T14:00:00.000Z'),
      timeZone: 'America/Toronto',
      externalSignal: false,
    });
    expect(plan.skipModel).toBe(false);
    expect(plan.candidates.map((candidate) => candidate.id)).toEqual(['open']);
  });

  it('reopens a clock-less hold when a parent reply or a calendar change arrived', () => {
    const plan = planHourlyReview({
      items: [item({ id: 'open', status: 'held', holdUntil: null })],
      now: NOW,
      timeZone: 'America/Toronto',
      externalSignal: true,
    });
    expect(plan.candidates.map((candidate) => candidate.id)).toEqual(['open']);
    expect(plan.priorDecisions[0]?.reason).toBe('no window yet');
  });

  it('treats a newly queued candidate as a signal and leaves a future hold out', () => {
    const plan = planHourlyReview({
      items: [
        item({ id: 'open', status: 'held', holdUntil: null }),
        item({
          id: 'fresh',
          status: 'queued',
          holdUntil: null,
          reason: null,
          decidedAt: null,
        }),
        item({
          id: 'later',
          status: 'held',
          holdUntil: '2026-10-09T13:00:00.000Z',
        }),
      ],
      now: NOW,
      timeZone: 'America/Toronto',
      externalSignal: false,
    });
    expect(plan.skipModel).toBe(false);
    expect(plan.candidates.map((candidate) => candidate.id)).toEqual(['fresh', 'open']);
    expect(plan.priorDecisions.map((decision) => decision.id)).toEqual(['open', 'later']);
  });
});
