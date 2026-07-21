import type { FamilyStage } from '@hale/types';
import { describe, expect, it } from 'vitest';
import {
  buildInput,
  eligibleKidsFor,
  type QuickLogChild,
  type QuickLogFormValues,
  visibleKindsFor,
} from './quick-log-kinds';

/**
 * C2 spec: feed, nap and diaper are only sensible for the youngest stages,
 * milestone applies at every age. These assert the stage→kind gating that keeps a
 * teen's parent from ever being offered a feed/nap/diaper log, derived from the
 * rule above — not from the component's current output.
 */

function child(stage: FamilyStage, id: string = stage): QuickLogChild {
  return { id, name: id, stage };
}

describe('quick-log stage gating', () => {
  it('offers feed, nap, diaper and milestone for a newborn', () => {
    expect(visibleKindsFor([child('newborn')])).toEqual(['feed', 'nap', 'diaper', 'milestone']);
  });

  it('offers feed, nap, diaper and milestone for a toddler', () => {
    expect(visibleKindsFor([child('toddler')])).toEqual(['feed', 'nap', 'diaper', 'milestone']);
  });

  it('offers only milestone for a school-age child', () => {
    expect(visibleKindsFor([child('child')])).toEqual(['milestone']);
  });

  it('offers only milestone for a teenager — never a feed, nap or diaper', () => {
    const kinds = visibleKindsFor([child('teenager')]);
    expect(kinds).toEqual(['milestone']);
    expect(kinds).not.toContain('feed');
    expect(kinds).not.toContain('nap');
    expect(kinds).not.toContain('diaper');
  });

  it('shows a kind when ANY child supports it, in feed→nap→diaper→milestone order', () => {
    const kids = [child('teenager', 'teen'), child('newborn', 'baby')];
    expect(visibleKindsFor(kids)).toEqual(['feed', 'nap', 'diaper', 'milestone']);
  });
});

describe('quick-log eligible children per kind', () => {
  const kids = [child('teenager', 'teen'), child('newborn', 'baby'), child('child', 'kid')];

  it('limits feed to the newborn — the teen and school-age child are excluded', () => {
    expect(eligibleKidsFor(kids, 'feed').map((c) => c.id)).toEqual(['baby']);
  });

  it('limits nap to the newborn', () => {
    expect(eligibleKidsFor(kids, 'nap').map((c) => c.id)).toEqual(['baby']);
  });

  it('limits diaper to the newborn', () => {
    expect(eligibleKidsFor(kids, 'diaper').map((c) => c.id)).toEqual(['baby']);
  });

  it('allows milestone for every child', () => {
    expect(eligibleKidsFor(kids, 'milestone').map((c) => c.id)).toEqual(['teen', 'baby', 'kid']);
  });
});

/**
 * buildInput turns the open form's raw values into the typed server-action input.
 * Expected shapes are derived from the quickLogSchema contract (a feed carries
 * EITHER a numeric amountMl OR a qualitative feedAmount ∈ little/half/most/all),
 * not copied from the builder's output. The qualitative "how much" chips and the
 * ml field are mutually exclusive in the UI; buildInput encodes which wins.
 */
const CHILD = '22222222-2222-4222-8222-222222222222';

function values(over: Partial<QuickLogFormValues> = {}): QuickLogFormValues {
  return {
    amountMl: '',
    feedAmount: '',
    feedKind: '',
    durationMin: '',
    diaperKind: 'wet',
    diaperNote: '',
    milestone: '',
    milestoneNote: '',
    when: '',
    ...over,
  };
}

describe('quick-log buildInput — feed amount (numeric vs qualitative)', () => {
  it('posts a numeric amountMl when the ml field is filled and no chip is picked', () => {
    expect(buildInput('feed', CHILD, values({ amountMl: '120' }))).toEqual({
      kind: 'feed',
      childId: CHILD,
      amountMl: 120,
    });
  });

  it('posts the qualitative feedAmount when a chip is picked and no ml is typed', () => {
    expect(buildInput('feed', CHILD, values({ feedAmount: 'most' }))).toEqual({
      kind: 'feed',
      childId: CHILD,
      feedAmount: 'most',
    });
  });

  it('carries the optional feedKind alongside a qualitative amount', () => {
    expect(buildInput('feed', CHILD, values({ feedAmount: 'half', feedKind: 'breast' }))).toEqual({
      kind: 'feed',
      childId: CHILD,
      feedAmount: 'half',
      feedKind: 'breast',
    });
  });

  it('prefers the qualitative chip over a stray ml value (the chip is the explicit pick)', () => {
    expect(buildInput('feed', CHILD, values({ feedAmount: 'all', amountMl: '90' }))).toEqual({
      kind: 'feed',
      childId: CHILD,
      feedAmount: 'all',
    });
  });

  it('returns null for a feed with neither an ml value nor a chip', () => {
    expect(buildInput('feed', CHILD, values())).toBeNull();
  });
});

describe('quick-log buildInput — diaper', () => {
  it('posts the picked diaper kind with no note when none is typed', () => {
    expect(buildInput('diaper', CHILD, values({ diaperKind: 'dirty' }))).toEqual({
      kind: 'diaper',
      childId: CHILD,
      diaperKind: 'dirty',
    });
  });

  it('carries an optional trimmed note alongside the kind', () => {
    expect(
      buildInput('diaper', CHILD, values({ diaperKind: 'mixed', diaperNote: '  leaked  ' })),
    ).toEqual({
      kind: 'diaper',
      childId: CHILD,
      diaperKind: 'mixed',
      note: 'leaked',
    });
  });

  it('returns null when no child is selected', () => {
    expect(buildInput('diaper', '', values({ diaperKind: 'wet' }))).toBeNull();
  });
});

describe('quick-log buildInput — nap, milestone, occurredAt', () => {
  it('posts a nap durationMin from the minutes field', () => {
    expect(buildInput('nap', CHILD, values({ durationMin: '45' }))).toEqual({
      kind: 'nap',
      childId: CHILD,
      durationMin: 45,
    });
  });

  it('posts a milestone with its trimmed text and optional note', () => {
    expect(
      buildInput('milestone', CHILD, values({ milestone: '  rolled over  ', milestoneNote: ' yay ' })),
    ).toEqual({
      kind: 'milestone',
      childId: CHILD,
      milestone: 'rolled over',
      note: 'yay',
    });
  });

  it('threads a picked "when" through as an ISO occurredAt', () => {
    const input = buildInput('feed', CHILD, values({ feedAmount: 'little', when: '2026-07-17T15:30' }));
    expect(input?.occurredAt).toBe(new Date('2026-07-17T15:30').toISOString());
  });

  it('returns null when no child is selected', () => {
    expect(buildInput('feed', '', values({ amountMl: '120' }))).toBeNull();
  });
});
