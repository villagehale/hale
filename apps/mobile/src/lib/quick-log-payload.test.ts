import { describe, expect, it } from 'vitest';

import {
  buildLogPayload,
  DIAPER_KIND,
  FEED_AMOUNT,
  FEED_WHAT,
  NAP_QUALITY,
} from './quick-log-payload';

/**
 * The native quick-log submission builder. Expected shapes are derived from the
 * design prototype (the sheet chips) and the server contract (apps/web log-types
 * quickLogSchema — feed needs a positive amountMl + optional feedKind ∈
 * bottle/breast/solid; diaper needs diaperKind ∈ wet/dirty/mixed/dry; nap needs a
 * start/end window; milestone needs its text), NOT copied from the builder's output.
 * The server-acceptance of these exact shapes is covered by the web log-types /
 * log-write tests; here we prove the mobile sheet constructs them.
 */

const CHILD = '11111111-1111-1111-1111-111111111111';
const OCCURRED = '2026-07-17T18:30:00.000Z';

const baseInput = {
  childId: CHILD,
  occurredAt: OCCURRED,
  feedWhat: 'Milk',
  feedAmount: 'Most of it',
  napQuality: 'Good',
  napStartAt: null,
  napEndAt: null,
  napDurationMin: null,
  diaperKind: 'wet' as const,
  milestone: '',
  note: '',
};

describe('buildLogPayload — feed', () => {
  it('maps "Milk" + "Most of it" to bottle feedKind and the qualitative "most" amount', () => {
    const payload = buildLogPayload({ ...baseInput, kind: 'feed' });
    expect(payload).toEqual({
      kind: 'feed',
      childId: CHILD,
      occurredAt: OCCURRED,
      feedAmount: 'most',
      feedKind: 'bottle',
    });
  });

  it('maps Breastmilk to breast and Solid food / Snack to solid', () => {
    expect(buildLogPayload({ ...baseInput, kind: 'feed', feedWhat: 'Breastmilk' }).feedKind).toBe(
      'breast',
    );
    expect(buildLogPayload({ ...baseInput, kind: 'feed', feedWhat: 'Solid food' }).feedKind).toBe(
      'solid',
    );
    expect(buildLogPayload({ ...baseInput, kind: 'feed', feedWhat: 'Snack' }).feedKind).toBe(
      'solid',
    );
  });

  it('omits feedKind for Water / Other (no matching server kind)', () => {
    expect(buildLogPayload({ ...baseInput, kind: 'feed', feedWhat: 'Water' })).not.toHaveProperty(
      'feedKind',
    );
    expect(buildLogPayload({ ...baseInput, kind: 'feed', feedWhat: 'Other' })).not.toHaveProperty(
      'feedKind',
    );
  });

  it('never sends a numeric amountMl — the feed is qualitative', () => {
    expect(buildLogPayload({ ...baseInput, kind: 'feed' })).not.toHaveProperty('amountMl');
  });

  it('maps each "How much" chip to its qualitative feedAmount enum', () => {
    const amt = (feedAmount: string) =>
      buildLogPayload({ ...baseInput, kind: 'feed', feedAmount }).feedAmount;
    expect(amt('A little')).toBe('little');
    expect(amt('Half')).toBe('half');
    expect(amt('Most of it')).toBe('most');
    expect(amt('All of it')).toBe('all');
  });

  it('includes a trimmed note only when the parent typed one', () => {
    expect(buildLogPayload({ ...baseInput, kind: 'feed' })).not.toHaveProperty('note');
    expect(
      buildLogPayload({ ...baseInput, kind: 'feed', note: '  avocado  ' }).note,
    ).toBe('avocado');
  });
});

describe('buildLogPayload — nap', () => {
  it('sends the start/end window and folds the quality into the note', () => {
    const payload = buildLogPayload({
      ...baseInput,
      kind: 'nap',
      napStartAt: '2026-07-17T13:15:00.000Z',
      napEndAt: '2026-07-17T15:00:00.000Z',
      napQuality: 'Excellent',
    });
    expect(payload).toEqual({
      kind: 'nap',
      childId: CHILD,
      occurredAt: OCCURRED,
      startAt: '2026-07-17T13:15:00.000Z',
      endAt: '2026-07-17T15:00:00.000Z',
      note: 'Quality: Excellent',
    });
  });

  it('sends a direct durationMin (the RN-web path) when there is no window', () => {
    const payload = buildLogPayload({
      ...baseInput,
      kind: 'nap',
      napDurationMin: 45,
      napQuality: 'Okay',
    });
    expect(payload).toEqual({
      kind: 'nap',
      childId: CHILD,
      occurredAt: OCCURRED,
      durationMin: 45,
      note: 'Quality: Okay',
    });
  });
});

describe('buildLogPayload — diaper', () => {
  it('sends the diaperKind for each kind in the fixed set', () => {
    for (const { value } of DIAPER_KIND) {
      const payload = buildLogPayload({ ...baseInput, kind: 'diaper', diaperKind: value });
      expect(payload).toEqual({ kind: 'diaper', childId: CHILD, occurredAt: OCCURRED, diaperKind: value });
    }
  });

  it('carries an optional note when present', () => {
    const payload = buildLogPayload({
      ...baseInput,
      kind: 'diaper',
      diaperKind: 'dirty',
      note: 'slight rash',
    });
    expect(payload).toEqual({
      kind: 'diaper',
      childId: CHILD,
      occurredAt: OCCURRED,
      diaperKind: 'dirty',
      note: 'slight rash',
    });
  });
});

describe('buildLogPayload — milestone', () => {
  it('sends the trimmed milestone text', () => {
    const payload = buildLogPayload({
      ...baseInput,
      kind: 'milestone',
      milestone: '  First steps  ',
    });
    expect(payload).toEqual({
      kind: 'milestone',
      childId: CHILD,
      occurredAt: OCCURRED,
      milestone: 'First steps',
    });
  });
});

describe('chip sets mirror the prototype', () => {
  it('exposes the six feed "what" labels in order', () => {
    expect(FEED_WHAT.map((w) => w.label)).toEqual([
      'Milk',
      'Solid food',
      'Snack',
      'Water',
      'Breastmilk',
      'Other',
    ]);
  });

  it('exposes the four "how much" and four quality labels', () => {
    expect(FEED_AMOUNT.map((a) => a.label)).toEqual(['A little', 'Half', 'Most of it', 'All of it']);
    expect([...NAP_QUALITY]).toEqual(['Poor', 'Okay', 'Good', 'Excellent']);
  });

  it('exposes the four diaper kinds as the server fixed set', () => {
    expect(DIAPER_KIND.map((d) => d.value)).toEqual(['wet', 'dirty', 'mixed', 'dry']);
  });
});
