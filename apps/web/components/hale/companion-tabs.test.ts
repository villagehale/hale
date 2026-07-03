import { companionForChild } from '@hale/types';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ChildCompanionView } from '~/lib/companion/queries';
import { CompanionTabs, nextTabIndex } from './companion-tabs';

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
