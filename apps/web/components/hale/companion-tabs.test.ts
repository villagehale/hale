import { companionForChild } from '@hale/types';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ChildCompanionView } from '~/lib/companion/queries';

// done-button (imported by companion-tabs) statically imports the 'use server'
// log module; stub the action so a static render doesn't pull the auth/db chain.
vi.mock('~/lib/companion/log', () => ({ markCompanionItemDone: vi.fn() }));

const { CompanionTabs, GrowthSection, MilestonesSection, RoutinesSection, nextTabIndex } =
  await import('./companion-tabs');

/**
 * The companion renders a plain header for one child and an accessible roving child
 * tablist for two or more (only the active child's body is mounted — no stacked
 * scroll). Below the header sits the six-section switcher (health / growth /
 * milestones / routines / diary / docs), defaulting to health. We render to static
 * HTML (the repo's component-test convention) for the DOM-structure guarantees, and
 * drive the pure keyboard reducer directly for the wraparound / Home / End model,
 * which a static render can't exercise.
 */

function child(id: string, name: string, dateOfBirth: string): ChildCompanionView {
  return { id, ...companionForChild({ dateOfBirth, name }) };
}

// Distinct DOBs → distinct stages/ages, so panels are distinguishable in the HTML.
const AVA = child('c-ava', 'Ava', '2025-01-01'); // ~newborn/infant
const BEN = child('c-ben', 'Ben', '2022-01-01'); // ~toddler
const CY = child('c-cy', 'Cy', '2016-01-01'); // ~school-age

const NO_PROPS = { routine: null, growthLogs: [], recentLogs: [], timeZone: 'America/Toronto' };

function render(kids: ChildCompanionView[]): string {
  return renderToStaticMarkup(createElement(CompanionTabs, { kids, ...NO_PROPS }));
}

describe('CompanionTabs DOM structure', () => {
  it('renders no CHILD tablist for a single child (only the section switcher)', () => {
    const html = render([AVA]);
    // No "children" tablist for a single child …
    expect(html).not.toContain('aria-label="children"');
    // … but the section switcher tablist is always present.
    expect(html).toContain('aria-label="companion sections"');
    expect(html).toContain('Ava');
  });

  it('renders both the child tablist and the section switcher for 2+ children', () => {
    const html = render([AVA, BEN, CY]);
    expect(html).toContain('aria-label="children"');
    expect(html).toContain('aria-label="companion sections"');
    // Three child tabs + six section tabs = nine role="tab" buttons.
    expect((html.match(/role="tab"/g) ?? []).length).toBe(3 + 6);
    // The mounted child body is Ava's (active); Ben/Cy bodies are absent.
    const panel = html.slice(html.indexOf('role="tabpanel"'));
    expect(panel).toContain('Ava');
    expect(panel).not.toContain('Ben');
    expect(panel).not.toContain('Cy');
  });

  it('defaults to the health section (its content, not growth/routines/docs)', () => {
    const html = render([AVA]);
    // Health leads with "what's next" + the health-items block.
    expect(html).toContain('what’s next');
    expect(html).toContain('health items');
    // The inactive sections' bodies are NOT mounted (single active section panel).
    expect(html).not.toContain('no measurements yet');
    expect(html).not.toContain('the vault lives in the Hale app');
    expect(html).not.toContain('no rhythm yet this week');
  });

  it('lists all six section tabs by label', () => {
    const html = render([AVA]);
    for (const label of ['health', 'growth', 'milestones', 'routines', 'diary', 'docs']) {
      expect(html).toContain(`>${label}<`);
    }
  });

  it('makes the section tabpanel programmatically focusable (ARIA requires tabIndex)', () => {
    const html = render([AVA]);
    const idx = html.indexOf('role="tabpanel"');
    const panelTag = html.slice(idx, html.indexOf('>', idx));
    expect(panelTag).toContain('tabindex="-1"');
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
    // must appear (not vanish) with the "scheduled at 4 months" phrasing + a done tap.
    const view = viewFor('2026-01-15');
    expect(view.recentlyPassedHealth.some((h) => h.ageMonths === 4)).toBe(true);

    const html = render([view]);
    expect(html).toContain('recently passed');
    expect(html).toContain('scheduled at 4 months');
    expect(html).toContain('4-month well-baby visit');
    // The done affordance (button) is present for the passed item.
    expect(html).toContain('mark done');
  });

  it('renders a done milestone as a settled sage pill, not a tappable "mark done"', () => {
    // 13mo toddler with "Walks independently" marked done → that row shows the done
    // pill; an undone milestone still shows the tappable affordance. Milestones live
    // in their own section (not the default health one), so render it directly.
    const done = { milestones: new Set(['Walks independently']), health: new Set<string>() };
    const html = renderToStaticMarkup(
      createElement(MilestonesSection, { child: viewFor('2025-05-15', done) }),
    );

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

  it('reads a newborn warmly ("under a month"), never the cold "0 months"', () => {
    // Born 2026-06-01, NOW 2026-06-15 → 0 completed months. The clinical "0 months"
    // is the exact cold phrasing the sweep bans.
    const view = viewFor('2026-06-01');
    expect(view.ageMonths).toBe(0);
    const html = render([view]);
    expect(html).toContain('under a month old');
    expect(html).not.toContain('0 months old');
  });
});

describe('GrowthSection', () => {
  const TZ = 'America/Toronto';

  it('shows the calm empty state when the child has no measurements', () => {
    const html = renderToStaticMarkup(
      createElement(GrowthSection, { child: AVA, growthLogs: [], timeZone: TZ }),
    );
    expect(html).toContain('no measurements yet');
    // Honest disclaimer: never a percentile / WHO curve.
    expect(html).toContain('no percentiles or WHO comparisons');
  });

  it('charts only the ACTIVE child’s measurement readings (family-wide list, filtered)', () => {
    const growthLogs = [
      { id: 'w-ava', childId: 'c-ava', episodeType: 'measurement', summary: '6.4 kg', occurredAt: '2026-06-01T10:00:00.000Z', measureKind: 'weight', value: 6.4, unit: 'kg' },
      { id: 'w-ben', childId: 'c-ben', episodeType: 'measurement', summary: '11 kg', occurredAt: '2026-06-01T10:00:00.000Z', measureKind: 'weight', value: 11, unit: 'kg' },
    ];
    const html = renderToStaticMarkup(
      createElement(GrowthSection, { child: AVA, growthLogs, timeZone: TZ }),
    );
    // Ava's reading is charted; Ben's (a different child) is filtered out.
    expect(html).toContain('6.4 kg');
    expect(html).not.toContain('11 kg');
    expect(html).not.toContain('no measurements yet');
  });
});

describe('RoutinesSection', () => {
  it('renders the calm empty state when there is no routine', () => {
    const html = renderToStaticMarkup(createElement(RoutinesSection, { routine: null }));
    expect(html).toContain('no rhythm yet this week');
  });

  it('locks a teen-attributed item to a private placeholder (rule #1), never its title', () => {
    const routine = {
      id: 'r-1',
      weekOf: '2026-06-15',
      items: [
        { title: 'THIS SHOULD NOT LEAK', kind: 'sport', stageNote: 'secret', day: 'monday', teenAttributed: true },
        { title: 'Family walk', kind: 'outing', stageNote: 'gentle', day: 'tuesday', teenAttributed: false },
      ],
    };
    const html = renderToStaticMarkup(createElement(RoutinesSection, { routine }));
    expect(html).not.toContain('THIS SHOULD NOT LEAK');
    expect(html).toContain('private');
    // The non-teen item's title renders normally.
    expect(html).toContain('Family walk');
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
