import { companionForChild } from '@hale/types';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { GrowthHeaderStat } from '~/lib/companion/growth-header';
import type { ChildCompanionView } from '~/lib/companion/queries';

// done-button (imported by companion-tabs) statically imports the 'use server'
// log module; stub the action so a static render doesn't pull the auth/db chain.
vi.mock('~/lib/companion/log', () => ({ markCompanionItemDone: vi.fn() }));

const {
  CompanionTabs,
  GrowthSection,
  HealthSection,
  MilestonesSection,
  RoutinesSection,
  nextTabIndex,
} = await import('./companion-tabs');

/**
 * The companion renders a child-hub header for one child and an accessible roving
 * child tablist for two or more (only the active child's body is mounted — no
 * stacked scroll). Below the header sits the §4.3 sub-tab switcher, which leads with
 * OVERVIEW (the default) followed by Health / Growth / Milestones / Routines /
 * Documents. We render to static HTML (the repo's component-test convention) for the
 * DOM-structure guarantees, and drive the pure keyboard reducer directly for the
 * wraparound / Home / End model, which a static render can't exercise.
 */

function child(id: string, name: string, dateOfBirth: string): ChildCompanionView {
  return { id, dateOfBirth, ...companionForChild({ dateOfBirth, name }) };
}

// Distinct DOBs → distinct stages/ages, so panels are distinguishable in the HTML.
const AVA = child('c-ava', 'Ava', '2025-01-01'); // ~newborn/infant
const BEN = child('c-ben', 'Ben', '2022-01-01'); // ~toddler
const CY = child('c-cy', 'Cy', '2016-01-01'); // ~school-age

// The complete honest-empty baseline for CompanionTabs (every prop required —
// individual tests spread this then override the slice under test).
const NO_PROPS = {
  routine: null,
  growthLogs: [],
  growthByChild: {},
  recentLogs: [],
  documents: [],
  members: { primary: null, coParent: null },
  viewerEmail: null,
  units: 'metric' as const,
  timeZone: 'America/Toronto',
  initialTab: 'overview' as const,
};

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
    // Three child tabs + six §4.3 sub-tabs = nine role="tab".
    expect((html.match(/role="tab"/g) ?? []).length).toBe(3 + 6);
    // The mounted child body is Ava's (active); Ben/Cy bodies are absent.
    const panel = html.slice(html.indexOf('role="tabpanel"'));
    expect(panel).toContain('Ava');
    expect(panel).not.toContain('Ben');
    expect(panel).not.toContain('Cy');
  });

  it('defaults to the overview panel (§4.3 cards, not the detail-section bodies)', () => {
    const html = render([AVA]);
    // Overview: Today at a glance + Development snapshot + insight / health summary +
    // Care team, with in-panel links — never the detail-section bodies.
    expect(html).toContain('today at a glance');
    expect(html).toContain('development snapshot');
    expect(html).toContain('care team');
    expect(html).toContain('View full timeline');
    expect(html).toContain('View health records');
    // Only the active overview panel renders — the other sections' bodies are absent.
    expect(html).not.toContain('health items');
    expect(html).not.toContain('no measurements yet');
    expect(html).not.toContain('no rhythm yet this week');
  });

  it('lists the six §4.3 sub-tabs by label, Overview leading', () => {
    const html = render([AVA]);
    for (const label of ['Overview', 'Health', 'Growth', 'Milestones', 'Routines', 'Documents']) {
      expect(html).toContain(`>${label}<`);
    }
    // Moments is NOT a sub-tab (no photo model on web — §4.3 reconciliation).
    expect(html).not.toContain('>Moments<');
  });

  it('makes the section tabpanel programmatically focusable (ARIA requires tabIndex)', () => {
    const html = render([AVA]);
    const idx = html.indexOf('role="tabpanel"');
    const panelTag = html.slice(idx, html.indexOf('>', idx));
    expect(panelTag).toContain('tabindex="-1"');
  });
});

describe('CompanionTabs — real WHO header + care team (§4.3, honesty lanes)', () => {
  const heightStat: GrowthHeaderStat = {
    kind: 'height',
    label: 'Height',
    valueMetric: 78.5,
    unit: 'cm',
    occurredAt: '2026-05-12T10:00:00.000Z',
    assessment: { state: 'assessed', z: -0.2, band: 'typical', percentile: 42 },
  };

  it('shows the REAL WHO percentile (not a fabricated one) in the child-hub header', () => {
    const html = renderToStaticMarkup(
      createElement(CompanionTabs, {
        kids: [AVA],
        ...NO_PROPS,
        growthByChild: { 'c-ava': [heightStat] },
      }),
    );
    expect(html).toContain('78.5 cm');
    expect(html).toContain('42nd %ile');
  });

  it('renders real caregivers in Care team, marks the viewer, offers the invite path', () => {
    const members = {
      primary: { name: 'Alex Chen', email: 'alex@example.com', role: 'primary_parent' as const },
      coParent: null,
    };
    const html = renderToStaticMarkup(
      createElement(CompanionTabs, {
        kids: [AVA],
        ...NO_PROPS,
        members,
        viewerEmail: 'alex@example.com',
      }),
    );
    expect(html).toContain('Alex Chen');
    // The viewer's chip carries the "You" badge (care-chip-you), not the co-parent slot.
    expect(html).toContain('>You<');
    // No fabricated co-parent / pediatrician — an honest invite path instead.
    expect(html).toContain('Invite a co-parent');
  });
});

describe('CompanionTabs done + recently-passed affordances', () => {
  // Fixed clock so the derivation is deterministic in the render.
  const NOW = new Date(2026, 5, 15); // 2026-06-15

  function viewFor(
    dateOfBirth: string,
    done?: { milestones: Set<string>; health: Set<string> },
  ): ChildCompanionView {
    return { id: 'c-1', dateOfBirth, ...companionForChild({ dateOfBirth, name: 'Ari' }, NOW, done) };
  }

  it('renders a recently-passed health item with a done affordance instead of hiding it', () => {
    // Born 2026-01-15 → 5mo: the 4-month set passed ~1mo ago and is not done, so it
    // must appear (not vanish) with the "scheduled at 4 months" phrasing + a done tap.
    const view = viewFor('2026-01-15');
    expect(view.recentlyPassedHealth.some((h) => h.ageMonths === 4)).toBe(true);

    const html = renderToStaticMarkup(createElement(HealthSection, { child: view }));
    expect(html).toContain('recently passed');
    expect(html).toContain('scheduled at 4 months');
    expect(html).toContain('4-month well-baby visit');
    expect(html).toContain('mark done');
  });

  it('renders a done milestone as a settled sage pill, not a tappable "mark done"', () => {
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
    const view = viewFor('2024-10-15');
    expect(view.todayHealth).toBeNull();
    const html = renderToStaticMarkup(createElement(HealthSection, { child: view }));
    expect(html).toContain('keep up periodic visits');
    expect(html).not.toContain('4–6 year (pre-school) immunizations —');
  });

  it('reads a newborn warmly ("under a month"), never the cold "0 months"', () => {
    const view = viewFor('2026-06-01');
    expect(view.ageMonths).toBe(0);
    const html = render([view]);
    expect(html).toContain('under a month');
    expect(html).not.toContain('0 months');
  });
});

describe('GrowthSection (real WHO seam)', () => {
  const TZ = 'America/Toronto';

  it('shows the calm empty state when the child has no measurements', () => {
    const html = renderToStaticMarkup(
      createElement(GrowthSection, {
        child: AVA,
        growthLogs: [],
        stats: [],
        units: 'metric',
        timeZone: TZ,
      }),
    );
    expect(html).toContain('no measurements yet');
    // Now backed by the real WHO seam — the honest reference disclaimer.
    expect(html).toContain('WHO Child Growth Standards');
  });

  it('shows the On-track pill ONLY when the seam computed a typical band', () => {
    const growthLogs = [
      { id: 'w-ava', childId: 'c-ava', episodeType: 'measurement', summary: '6.4 kg', occurredAt: '2026-06-01T10:00:00.000Z', measureKind: 'weight', value: 6.4, unit: 'kg' },
    ];
    const stats: GrowthHeaderStat[] = [
      { kind: 'weight', label: 'Weight', valueMetric: 6.4, unit: 'kg', occurredAt: '2026-06-01T10:00:00.000Z', assessment: { state: 'assessed', z: 0.1, band: 'typical', percentile: 54 } },
    ];
    const html = renderToStaticMarkup(
      createElement(GrowthSection, { child: AVA, growthLogs, stats, units: 'metric', timeZone: TZ }),
    );
    expect(html).toContain('On track');
    expect(html).toContain('54th %ile');
  });

  it('omits the pill when the seam could not assess (needs details) — never a fabricated verdict', () => {
    const growthLogs = [
      { id: 'w-ava', childId: 'c-ava', episodeType: 'measurement', summary: '6.4 kg', occurredAt: '2026-06-01T10:00:00.000Z', measureKind: 'weight', value: 6.4, unit: 'kg' },
    ];
    const stats: GrowthHeaderStat[] = [
      { kind: 'weight', label: 'Weight', valueMetric: 6.4, unit: 'kg', occurredAt: '2026-06-01T10:00:00.000Z', assessment: { state: 'needs-details' } },
    ];
    const html = renderToStaticMarkup(
      createElement(GrowthSection, { child: AVA, growthLogs, stats, units: 'metric', timeZone: TZ }),
    );
    expect(html).toContain('6.4 kg');
    expect(html).not.toContain('On track');
    expect(html).not.toContain('Worth a look');
  });

  it('charts only the ACTIVE child’s measurement readings (family-wide list, filtered)', () => {
    const growthLogs = [
      { id: 'w-ava', childId: 'c-ava', episodeType: 'measurement', summary: '6.4 kg', occurredAt: '2026-06-01T10:00:00.000Z', measureKind: 'weight', value: 6.4, unit: 'kg' },
      { id: 'w-ben', childId: 'c-ben', episodeType: 'measurement', summary: '11 kg', occurredAt: '2026-06-01T10:00:00.000Z', measureKind: 'weight', value: 11, unit: 'kg' },
    ];
    const html = renderToStaticMarkup(
      createElement(GrowthSection, {
        child: AVA,
        growthLogs,
        stats: [],
        units: 'metric',
        timeZone: TZ,
      }),
    );
    expect(html).toContain('6.4 kg');
    expect(html).not.toContain('11 kg');
    expect(html).not.toContain('no measurements yet');
  });

  it('renders readings in the viewer’s unit — imperial converts the stored metric value', () => {
    const growthLogs = [
      { id: 'w-ava', childId: 'c-ava', episodeType: 'measurement', summary: '6.4 kg', occurredAt: '2026-06-01T10:00:00.000Z', measureKind: 'weight', value: 6.4, unit: 'kg' },
    ];
    const html = renderToStaticMarkup(
      createElement(GrowthSection, {
        child: AVA,
        growthLogs,
        stats: [],
        units: 'imperial',
        timeZone: TZ,
      }),
    );
    // 6.4 kg × 2.20462 = 14.11 → 14.1 lb. Stored value is metric; only the display converts.
    expect(html).toContain('14.1 lb');
    expect(html).not.toContain('6.4 kg');
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
    expect(html).toContain('Family walk');
  });
});

describe('CompanionTabs Documents tab (real vault)', () => {
  it('lists a real vault document with its size + kind, and no fabricated open link', () => {
    const documents = [
      {
        id: 'd-1',
        childId: 'c-ava',
        kind: 'health',
        title: 'Health card',
        mime: 'application/pdf',
        sizeBytes: 1_500_000,
        createdAt: '2025-03-02T00:00:00.000Z',
      },
    ];
    const html = renderToStaticMarkup(
      createElement(CompanionTabs, {
        kids: [AVA],
        ...NO_PROPS,
        documents,
        initialTab: 'documents' as const,
      }),
    );
    expect(html).toContain('Health card');
    expect(html).toContain('1.5 MB');
  });

  it('shows the honest empty state when the vault has nothing for this child', () => {
    const html = renderToStaticMarkup(
      createElement(CompanionTabs, {
        kids: [AVA],
        ...NO_PROPS,
        documents: [],
        initialTab: 'documents' as const,
      }),
    );
    expect(html).toContain('no documents yet');
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
