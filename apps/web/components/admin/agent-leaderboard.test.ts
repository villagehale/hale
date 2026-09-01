import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { lastDays } from '~/lib/admin/window';
import { AgentLeaderboard, rankAgents } from './agent-leaderboard';

/** The fleet leaderboard: day-grain rows → dial-sliced per-agent sums. */
describe('rankAgents', () => {
  it('slices the dial window, sums per agent, ranks by runs, formats cost', () => {
    const [dayA, dayB] = lastDays(2);
    if (!dayA || !dayB) throw new Error('lastDays returned too few keys');
    const ranked = rankAgents(
      [
        { day: dayA, agent: 'reviewer', runs: 2, failedRuns: 1, costUsd: 0.02 },
        { day: dayB, agent: 'reviewer', runs: 1, failedRuns: 0, costUsd: 0.01 },
        { day: dayB, agent: 'drafter', runs: 5, failedRuns: 0, costUsd: 0.5 },
        { day: '2020-01-01', agent: 'ghost', runs: 99, failedRuns: 0, costUsd: 9 },
      ],
      7,
    );
    expect(ranked).toEqual([
      { agent: 'drafter', runs: 5, failed: 0, cost: '$0.50' },
      { agent: 'reviewer', runs: 3, failed: 1, cost: '$0.03' },
    ]);
  });
});

describe('AgentLeaderboard render', () => {
  it('mounts the sortable/filterable table with the runs share bar', () => {
    const [today] = lastDays(1);
    if (!today) throw new Error('lastDays returned no key');
    const html = renderToStaticMarkup(
      createElement(AgentLeaderboard, {
        rows: [{ day: today, agent: 'reviewer', runs: 4, failedRuns: 2, costUsd: 0.25 }],
      }),
    );
    expect(html).toContain('reviewer');
    expect(html).toContain('adm-cell-bar');
    expect(html).toContain('$0.25');
    expect(html).toContain('placeholder="filter agents…"');
  });

  it('renders the honest empty line when the window holds no runs', () => {
    const html = renderToStaticMarkup(createElement(AgentLeaderboard, { rows: [] }));
    expect(html).toContain('No runs in this window.');
  });
});
