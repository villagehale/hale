import { describe, expect, it } from 'vitest';

import type { VillageCandidateView } from './api-types';
import { aiSearchErrorMessage, aiSearchViewFrom } from './village-ai-search';

/**
 * The Village natural-language search view state. Expected values are derived from the
 * server contract (ai-search-action): real results → a results view; a thin result set
 * that kicked background discovery → the "out looking" view; a genuinely empty intent
 * with no results → the empty view. The interpretation echo is carried through in every
 * case. Errors map to honest copy by status.
 */
function candidate(id: string): VillageCandidateView {
  return { id, title: `t-${id}` } as VillageCandidateView;
}

describe('aiSearchViewFrom', () => {
  const interpretation = 'montessori · activities · for your family';

  it('shows results when the search returned any', () => {
    const view = aiSearchViewFrom({
      interpretation,
      results: [candidate('a'), candidate('b')],
      degraded: false,
      discoveryKicked: false,
    });
    expect(view).toEqual({
      kind: 'results',
      interpretation,
      results: [candidate('a'), candidate('b')],
    });
  });

  it('shows "out looking" when there are no results yet but discovery was kicked', () => {
    const view = aiSearchViewFrom({
      interpretation,
      results: [],
      degraded: false,
      discoveryKicked: true,
    });
    expect(view).toEqual({ kind: 'out-looking', interpretation });
  });

  it('shows the empty view when there are no results and no discovery (empty intent)', () => {
    const view = aiSearchViewFrom({
      interpretation: 'near you',
      results: [],
      degraded: false,
      discoveryKicked: false,
    });
    expect(view).toEqual({ kind: 'empty', interpretation: 'near you' });
  });

  it('prefers results even when discovery was also kicked', () => {
    const view = aiSearchViewFrom({
      interpretation,
      results: [candidate('a')],
      degraded: false,
      discoveryKicked: true,
    });
    expect(view.kind).toBe('results');
  });
});

describe('aiSearchErrorMessage', () => {
  it('maps a 429 to rate-limit copy', () => {
    expect(aiSearchErrorMessage(429)).toMatch(/searched a lot|moment/i);
  });

  it('maps a 403 to a finish-setup message', () => {
    expect(aiSearchErrorMessage(403)).toMatch(/family/i);
  });

  it('maps anything else to a generic retry message', () => {
    expect(aiSearchErrorMessage(500)).toMatch(/try again/i);
    expect(aiSearchErrorMessage(0)).toMatch(/try again/i);
  });
});
