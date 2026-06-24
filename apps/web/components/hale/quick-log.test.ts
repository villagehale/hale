import type { FamilyStage } from '@hale/types';
import { describe, expect, it } from 'vitest';
import {
  eligibleKidsFor,
  type QuickLogChild,
  visibleKindsFor,
} from './quick-log-kinds';

/**
 * C2 spec: feed and nap are only sensible for the youngest stages, milestone
 * applies at every age. These assert the stage→kind gating that keeps a teen's
 * parent from ever being offered a feed/nap log, derived from the rule above —
 * not from the component's current output.
 */

function child(stage: FamilyStage, id: string = stage): QuickLogChild {
  return { id, name: id, stage };
}

describe('quick-log stage gating', () => {
  it('offers feed, nap and milestone for a newborn', () => {
    expect(visibleKindsFor([child('newborn')])).toEqual(['feed', 'nap', 'milestone']);
  });

  it('offers feed, nap and milestone for a toddler', () => {
    expect(visibleKindsFor([child('toddler')])).toEqual(['feed', 'nap', 'milestone']);
  });

  it('offers only milestone for a school-age child', () => {
    expect(visibleKindsFor([child('child')])).toEqual(['milestone']);
  });

  it('offers only milestone for a teenager — never a feed or nap', () => {
    const kinds = visibleKindsFor([child('teenager')]);
    expect(kinds).toEqual(['milestone']);
    expect(kinds).not.toContain('feed');
    expect(kinds).not.toContain('nap');
  });

  it('shows a kind when ANY child supports it, in feed→nap→milestone order', () => {
    const kids = [child('teenager', 'teen'), child('newborn', 'baby')];
    expect(visibleKindsFor(kids)).toEqual(['feed', 'nap', 'milestone']);
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

  it('allows milestone for every child', () => {
    expect(eligibleKidsFor(kids, 'milestone').map((c) => c.id)).toEqual(['teen', 'baby', 'kid']);
  });
});
