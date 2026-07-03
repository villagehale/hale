import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ScopeChild } from './child-scope';
import type { LogsPage } from '~/lib/companion/logs-view';

// The browser calls the edit/delete 'use server' actions on interaction; importing
// them would drag next-auth into this markup-only render. Stub the module.
vi.mock('~/lib/companion/log', () => ({
  editQuickEpisode: vi.fn(),
  deleteQuickEpisode: vi.fn(),
}));

import { LogsBrowser } from './logs-browser';

/**
 * The dedicated logs view groups a page by day and offers a per-child filter with
 * edit/delete affordances per row. We render to static HTML (the repo idiom) and
 * assert the accessibility + grouping structure that regresses silently: a day
 * heading per distinct day, an edit + a remove control per row (with a labelled
 * accessible name), and the whole-family-first scope filter. A teen's given name
 * is never in the markup (rule #1) — the filter shows "your teen".
 */

function log(id: string, occurredAt: string, summary: string) {
  return { id, childId: null, episodeType: 'feed', summary, occurredAt };
}

const PAGE: LogsPage = {
  logs: [
    log('a', '2026-06-30T18:00:00Z', 'Fed 120 ml'),
    log('b', '2026-06-30T09:00:00Z', 'Napped 45 min'),
    log('c', '2026-06-29T20:00:00Z', 'Rolled over'),
  ],
  nextCursor: null,
};

const KIDS: ScopeChild[] = [
  { id: 'k1', label: 'Mara' },
  { id: 'k2', label: null }, // teen — name withheld
];

function render(page = PAGE, kids = KIDS) {
  return renderToStaticMarkup(createElement(LogsBrowser, { initial: page, kids }));
}

describe('LogsBrowser', () => {
  it('groups the page into one section per distinct day (two days → two headings)', () => {
    const html = render();
    // Both June 30 rows share one section; June 29 is its own — two day headings.
    const headings = html.match(/<h2[^>]*>/g) ?? [];
    expect(headings).toHaveLength(2);
    expect(html).toContain('Fed 120 ml');
    expect(html).toContain('Rolled over');
  });

  it('offers an edit and a remove control per row, each with an accessible name', () => {
    const html = render();
    expect(html).toContain('aria-label="edit log: Fed 120 ml"');
    expect(html).toContain('aria-label="remove log: Fed 120 ml"');
  });

  it('shows a whole-family-first per-child filter and never leaks a teen name (rule #1)', () => {
    const html = render();
    expect(html).toContain('whole family');
    expect(html).toContain('Mara');
    expect(html).toContain('your teen');
    // The teen id may appear as a value, but the withheld given name must not be invented.
  });

  it('renders the calm empty state (no day headings) for an empty page', () => {
    const html = render({ logs: [], nextCursor: null });
    expect(html).not.toContain('<h2');
    expect(html.toLowerCase()).toContain('nothing logged');
  });

  it('offers "load more" only when a next cursor exists', () => {
    const withMore = render({ logs: PAGE.logs, nextCursor: '2026-06-29T20:00:00Z' });
    expect(withMore).toContain('load more');

    const lastPage = render(PAGE);
    expect(lastPage).not.toContain('load more');
  });
});
