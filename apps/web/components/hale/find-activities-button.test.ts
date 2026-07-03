import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// The button transitively imports a 'use server' action (→ ~/auth → next-auth),
// which vitest can't resolve. Mock the action so the static-markup render works.
vi.mock('~/lib/village/discover-action', () => ({ findActivitiesAction: vi.fn() }));

import { FindActivitiesButton } from './find-activities-button';

/**
 * Discovery is re-runnable, and the one entry point reads two ways: the primary
 * CTA on an empty surface, and a quiet secondary "find more" at the foot of a
 * populated feed. We render to static HTML (the repo's render idiom) and assert
 * the variant→class and label wiring, plus that the button starts ENABLED — so a
 * populated village/home can re-trigger discovery, not just the empty state.
 */
describe('FindActivitiesButton — one re-runnable entry point, two voices', () => {
  it('defaults to the primary CTA voice for an empty surface', () => {
    const html = renderToStaticMarkup(createElement(FindActivitiesButton));
    expect(html).toContain('btn-primary');
    expect(html).not.toContain('btn-secondary');
    expect(html).toContain('find activities near you');
  });

  it('reads as a quiet secondary "find more" in a populated feed', () => {
    const html = renderToStaticMarkup(
      createElement(FindActivitiesButton, { variant: 'secondary', label: 'find more near you' }),
    );
    expect(html).toContain('btn-secondary');
    expect(html).not.toContain('btn-primary');
    expect(html).toContain('find more near you');
  });

  it('starts enabled — discovery is not a one-shot', () => {
    const html = renderToStaticMarkup(
      createElement(FindActivitiesButton, { variant: 'secondary', label: 'find more near you' }),
    );
    expect(html).not.toContain('disabled');
  });
});
