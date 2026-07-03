import { companionForChild } from '@hale/types';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ChildCompanionView } from '~/lib/companion/queries';

// done-button (imported by companion-tabs) statically imports the 'use server'
// log module; stub the action so a static render doesn't pull the auth/db chain.
vi.mock('~/lib/companion/log', () => ({ markCompanionItemDone: vi.fn() }));

const { CompanionTabs, nextTabIndex } = await import('./companion-tabs');

/**
 * The companion renders a plain panel for one child and an accessible roving
 * tablist for two or more (only the active child's panel is mounted — no stacked
 * scroll). We render to static HTML (the repo's component-test convention) for the
 * DOM-structure guarantees, and drive the pure keyboard reducer directly for the
 * wraparound / Home / End model, which a static render can't exercise.
 */

function child(id: string, name: string, dateOfBirth: string): ChildCompanionView {
  return { id, ...companionForChild({ dateOfBirth, name }) };
}

// Distinct DOBs → distinct stages/ages, so panels are distinguishable in the HTML.
const AVA = child('c-ava', 'Ava', '2025-01-01'); // ~newborn/infant
const BEN = child('c-ben', 'Ben', '2022-01-01'); // ~toddler
const CY = child('c-cy', 'Cy', '2016-01-01'); // ~school-age

function render(kids: ChildCompanionView[]): string {
  return renderToStaticMarkup(createElement(CompanionTabs, { kids }));
}

describe('CompanionTabs DOM structure', () => {
  it('renders no tablist for a single child', () => {
    const html = render([AVA]);
    expect(html).not.toContain('role="tablist"');
    expect(html).not.toContain('role="tab"');
    expect(html).toContain('Ava');
  });

  it('renders a tablist and mounts only the active child panel for 2+ children', () => {
    const html = render([AVA, BEN, CY]);
    expect(html).toContain('role="tablist"');
    // One tab button per child.
    expect((html.match(/role="tab"/g) ?? []).length).toBe(3);
    // Exactly one tabpanel, and it belongs to the default-active (first) child.
    expect((html.match(/role="tabpanel"/g) ?? []).length).toBe(1);
    // Active tab is the first; the others are not selected.
    expect((html.match(/aria-selected="true"/g) ?? []).length).toBe(1);
    expect((html.match(/aria-selected="false"/g) ?? []).length).toBe(2);
    // The mounted panel is Ava's (active); Ben/Cy panels are absent.
    const panel = html.slice(html.indexOf('role="tabpanel"'));
    expect(panel).toContain('Ava');
    expect(panel).not.toContain('Ben');
    expect(panel).not.toContain('Cy');
  });
});

describe('CompanionTabs done + recently-passed affordances', () => {
  // Fixed clock so the derivation is deterministic in the render.
  const NOW = new Date(2026, 5, 15); // 2026-06-15

  function viewFor(
    dateOfBirth: string,
    done?: { milestones: Set<string>; health: Set<string> },
  ): ChildCompanionView {
    return { id: 'c-1', ...companionForChild({ dateOfBirth, name: 'Ari' }, NOW, done) };
  }

  it('renders a recently-passed health item with a done affordance instead of hiding it', () => {
    // Born 2026-01-15 → 5mo: the 4-month set passed ~1mo ago and is not done, so it
    // must appear (not vanish) with the "was due at 4 months" phrasing + a done tap.
    const view = viewFor('2026-01-15');
    expect(view.recentlyPassedHealth.some((h) => h.ageMonths === 4)).toBe(true);

    const html = render([view]);
    expect(html).toContain('recently passed');
    expect(html).toContain('was due at 4 months');
    expect(html).toContain('4-month well-baby visit');
    // The done affordance (button) is present for the passed item.
    expect(html).toContain('mark done');
  });

  it('renders a done milestone as a settled sage pill, not a tappable "mark done"', () => {
    // 13mo toddler with "Walks independently" marked done → that row shows the done
    // pill; an undone milestone still shows the tappable affordance.
    const done = { milestones: new Set(['Walks independently']), health: new Set<string>() };
    const html = render([viewFor('2025-05-15', done)]);

    expect(html).toContain('Walks independently');
    // Some milestone is still tappable (the undone ones) …
    expect(html).toContain('mark done');
    // … and the done pill is rendered (pill-sage) for the completed one.
    expect(html).toContain('pill-sage');
  });

  it('leads with the horizon note rather than a checkup years away', () => {
    // Born 2024-10-15 → 20mo: next real item is the 4–6y set (out of horizon), so
    // the lead must NOT surface it and must fall back to the periodic-visits note.
    const view = viewFor('2024-10-15');
    expect(view.todayHealth).toBeNull();
    const html = render([view]);
    expect(html).toContain('keep up periodic visits');
    expect(html).not.toContain('4–6 year (pre-school) immunizations —');
  });
});

describe('nextTabIndex keyboard model (count = 3, indices 0..2)', () => {
  it('ArrowRight/ArrowDown advance and wrap past the last tab', () => {
    expect(nextTabIndex('ArrowRight', 0, 3)).toBe(1);
    expect(nextTabIndex('ArrowRight', 1, 3)).toBe(2);
    expect(nextTabIndex('ArrowRight', 2, 3)).toBe(0);
    expect(nextTabIndex('ArrowDown', 2, 3)).toBe(0);
  });

  it('ArrowLeft/ArrowUp retreat and wrap before the first tab', () => {
    expect(nextTabIndex('ArrowLeft', 2, 3)).toBe(1);
    expect(nextTabIndex('ArrowLeft', 0, 3)).toBe(2);
    expect(nextTabIndex('ArrowUp', 0, 3)).toBe(2);
  });

  it('Home jumps to the first tab, End jumps to the last', () => {
    expect(nextTabIndex('Home', 2, 3)).toBe(0);
    expect(nextTabIndex('End', 0, 3)).toBe(2);
  });

  it('ignores keys outside the roving model', () => {
    expect(nextTabIndex('Tab', 1, 3)).toBeNull();
    expect(nextTabIndex('Enter', 1, 3)).toBeNull();
    expect(nextTabIndex(' ', 1, 3)).toBeNull();
  });
});
