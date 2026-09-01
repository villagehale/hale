import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { lastDays } from '~/lib/admin/window';
import { IntakeSourcesTable, rankSources } from './intake-sources-table';

/** Which poster works: day-grain source rows → ranked window sums. */
describe('rankSources', () => {
  it('slices the dial window, sums per code, ranks by starts, derives conversion', () => {
    const [dayA, dayB] = lastDays(2);
    if (!dayA || !dayB) throw new Error('lastDays returned too few keys');
    const ranked = rankSources(
      [
        { day: dayA, code: 'earlyon', started: 3, provisioned: 1 },
        { day: dayB, code: 'earlyon', started: 1, provisioned: 1 },
        { day: dayB, code: 'direct', started: 6, provisioned: 0 },
        { day: '2020-01-01', code: 'library', started: 50, provisioned: 50 },
      ],
      7,
    );
    expect(ranked).toEqual([
      { source: 'direct', started: 6, family: 0, conversion: '0%' },
      { source: 'earlyon', started: 4, family: 2, conversion: '50%' },
    ]);
  });

  it('never divides by zero — a zero-start code shows a dash', () => {
    const [today] = lastDays(1);
    if (!today) throw new Error('lastDays returned no key');
    expect(rankSources([{ day: today, code: 'qr', started: 0, provisioned: 0 }], 7)).toEqual([
      { source: 'qr', started: 0, family: 0, conversion: '—' },
    ]);
  });
});

describe('IntakeSourcesTable render', () => {
  it('mounts the sortable/filterable table with an in-cell share bar', () => {
    const [today] = lastDays(1);
    if (!today) throw new Error('lastDays returned no key');
    const html = renderToStaticMarkup(
      createElement(IntakeSourcesTable, {
        sources: [{ day: today, code: 'earlyon', started: 4, provisioned: 2 }],
      }),
    );
    expect(html).toContain('earlyon');
    expect(html).toContain('adm-cell-bar');
    expect(html).toContain('placeholder="filter sources…"');
    expect(html).toContain('50%'); // the conversion column
  });

  it('renders the honest empty line when the window holds no sources', () => {
    const html = renderToStaticMarkup(createElement(IntakeSourcesTable, { sources: [] }));
    expect(html).toContain('No sources in this window — direct texts only.');
  });
});
