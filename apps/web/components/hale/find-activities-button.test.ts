import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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

/**
 * First-run guidance must be human and point at the REAL area editor
 * (/family/members, where FamilyLocation renders), not the /family hub (a nav
 * index with no area field) nor "settings". The no-area copy is a result state we
 * can't reach in a static render, so we assert against the source: the
 * /family/members link is wired, and the banned engineer-voice tokens are gone.
 */
describe('FindActivitiesButton — first-run copy points at the real area editor', () => {
  const source = readFileSync(
    fileURLToPath(new URL('./find-activities-button.tsx', import.meta.url)),
    'utf8',
  );

  it('links the no-area guidance to the family members page (where the area lives)', () => {
    expect(source).toContain("href: '/family/members'");
    expect(source).toContain('add your area on the family page');
  });

  it('bans engineer-voice tokens from the user copy', () => {
    expect(source).not.toContain('coarse area');
    expect(source).not.toContain('stage-appropriate');
    expect(source).not.toContain('(in settings)');
    // No standalone lowercase "i" as a pronoun in user copy (e.g. "i can gather").
    expect(source).not.toMatch(/\bi can\b/);
  });
});
