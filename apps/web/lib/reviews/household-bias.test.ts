import { describe, expect, it } from 'vitest';
import {
  biasFindOrder,
  biasFromVerdicts,
  candidateReviewSubject,
  emptyHouseholdFindBias,
} from './household-bias';

describe('household find bias', () => {
  it('ignores did_not_attend and keeps the last verdict per subject', () => {
    const bias = biasFromVerdicts([
      { source: 'place', ref: 'places/pool', verdict: 'worth_it' },
      { source: 'place', ref: 'places/pool', verdict: 'did_not_attend' },
      { source: 'civic_venue', ref: 'venue-1', verdict: 'not_worth_it' },
    ]);
    expect([...bias.prefer]).toEqual([]);
    expect([...bias.avoid]).toEqual(['civic_venue:venue-1']);
  });

  it('floats worth_it and drops not_worth_it when another option remains', () => {
    const items = [
      { id: 'avoid', placeId: 'places/no' },
      { id: 'neutral', placeId: null, civicVenueId: null },
      { id: 'prefer', placeId: 'places/yes' },
    ];
    const bias = biasFromVerdicts([
      { source: 'place', ref: 'places/no', verdict: 'not_worth_it' },
      { source: 'place', ref: 'places/yes', verdict: 'worth_it' },
    ]);
    expect(
      biasFindOrder(items, (item) => candidateReviewSubject(item), bias).map((item) => item.id),
    ).toEqual(['prefer', 'neutral']);
  });

  it('keeps a disliked option when it is the only one', () => {
    const items = [{ id: 'only', civicVenueId: 'venue-1' }];
    const bias = biasFromVerdicts([
      { source: 'civic_venue', ref: 'venue-1', verdict: 'not_worth_it' },
    ]);
    expect(biasFindOrder(items, (item) => candidateReviewSubject(item), bias)).toEqual(items);
  });

  it('is a no-op with an empty bias', () => {
    const items = [{ id: 'a', placeId: 'places/a' }, { id: 'b' }];
    expect(
      biasFindOrder(items, (item) => candidateReviewSubject(item), emptyHouseholdFindBias()),
    ).toEqual(items);
  });
});
