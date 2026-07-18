import { describe, expect, it } from 'vitest';

import type { CuratedResourceView } from './api-types';
import { CHILDCARE_RESOURCE_CATEGORY, childcareResources } from './childcare';

function resource(over: Partial<CuratedResourceView>): CuratedResourceView {
  return {
    id: 'r',
    name: 'A program',
    category: 'Public health',
    area: 'Halton Hills',
    url: 'https://example.org',
    description: 'A public program.',
    ...over,
  };
}

describe('childcareResources — real childcare rows from curated resources', () => {
  it('keeps ONLY the childcare category, dropping other public programs', () => {
    const earlyon = resource({ id: 'earlyon', category: CHILDCARE_RESOURCE_CATEGORY });
    const filtered = childcareResources([
      earlyon,
      resource({ id: 'library', category: "Public library children's programs" }),
      resource({ id: 'health', category: 'Public health' }),
    ]);
    expect(filtered).toEqual([earlyon]);
  });

  it('returns an empty list (never throws) when resources are absent', () => {
    expect(childcareResources(undefined)).toEqual([]);
    expect(childcareResources([])).toEqual([]);
  });
});
