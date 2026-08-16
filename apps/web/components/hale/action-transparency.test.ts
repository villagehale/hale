import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ActionReview } from '~/lib/dashboard/action-review';
import type { TrailView } from '~/lib/dashboard/mappers';
import { ActionProgress, ReviewNote } from './action-progress';
import { TrailTimeline } from './trail-timeline';

/**
 * The rendered half of the receipts-room transparency upgrade: the status rail and
 * the reviewer's note on /approvals, and the folded lifecycle on /trail.
 *
 * Every fixture is shaped like the real query output (action-review.ts / mappers.ts),
 * and the assertions are about what a parent can READ — because the whole point of
 * the upgrade is that a claim on screen has a stored fact behind it.
 */

function review(overrides: Partial<ActionReview> = {}): ActionReview {
  return {
    note: 'The clinic is already on your recipient list.',
    checks: [
      { label: 'known recipient', ok: true, capUsd: null },
      { label: 'calendar clear', ok: true, capUsd: null },
    ],
    steps: [
      { key: 'drafted', label: 'drafted', at: 'Aug 2, 08:04', tone: 'done' },
      { key: 'reviewed', label: 'verified', at: 'Aug 2, 08:05', tone: 'done' },
      { key: 'open', label: 'waiting on your yes', at: null, tone: 'awaiting' },
    ],
    ...overrides,
  };
}

describe('ActionProgress — the rail', () => {
  it('renders one rung per step, with its stamp', () => {
    const html = renderToStaticMarkup(h(ActionProgress, { review: review() }));
    expect(html).toContain('drafted');
    expect(html).toContain('Aug 2, 08:04');
    expect(html).toContain('verified');
    expect(html).toContain('waiting on your yes');
    // Three <li>, not a paragraph pretending to be a rail.
    expect([...html.matchAll(/<li/g)]).toHaveLength(3);
  });

  it('shows no stamp on the open rung — it has not happened', () => {
    const html = renderToStaticMarkup(
      h(ActionProgress, {
        review: review({
          steps: [{ key: 'open', label: 'waiting on Hale’s review', at: null, tone: 'awaiting' }],
        }),
      }),
    );
    expect(html).toContain('waiting on Hale’s review');
    // The `.tabular` stamp span only exists when there is something to stamp.
    expect(html).not.toContain('tabular');
  });

  it('carries the state by SHAPE as well as colour — the tone glyph rides each rung', () => {
    const html = renderToStaticMarkup(h(ActionProgress, { review: review() }));
    // The done disc and the awaiting ring are different SVG primitives, so a rail
    // read without colour still distinguishes settled from open.
    expect(html).toContain('<circle cx="8" cy="8" r="6"');
    expect(html).toContain('fill="none"');
  });
});

describe('ReviewNote — why the draft got through', () => {
  it('shows the reviewer’s recorded sentence and each check it invoked', () => {
    const html = renderToStaticMarkup(h(ReviewNote, { review: review() }));
    expect(html).toContain('before this reached you');
    expect(html).toContain('The clinic is already on your recipient list.');
    expect(html).toContain('known recipient');
    expect(html).toContain('calendar clear');
  });

  it('tints a failed check apart from a passing one, and prints only a stored cap', () => {
    const html = renderToStaticMarkup(
      h(ReviewNote, {
        review: review({
          checks: [
            { label: 'over your cap', ok: false, capUsd: 50 },
            { label: 'inside your cap', ok: true, capUsd: null },
          ],
        }),
      }),
    );
    expect(html).toContain('pill-berry');
    expect(html).toContain('pill-sage');
    expect(html).toContain('$50');
    // The passing branch stores no figure, so none is shown — one cap on the card,
    // not one per chip.
    expect([...html.matchAll(/\$50/g)]).toHaveLength(1);
  });

  it('renders the checks for a redacted draft, whose prose was withheld upstream', () => {
    const html = renderToStaticMarkup(h(ReviewNote, { review: review({ note: null }) }));
    expect(html).toContain('known recipient');
    expect(html).toContain('before this reached you');
  });

  it('renders nothing at all when the reviewer recorded nothing', () => {
    expect(renderToStaticMarkup(h(ReviewNote, { review: review({ note: null, checks: [] }) }))).toBe(
      '',
    );
  });
});

// ── /trail — the folded lifecycle ────────────────────────────────────────────

const ACTION_ID = 'ac710000-0000-4000-8000-000000000001';

function step(id: string, time: string, summary: string, over: Partial<TrailView> = {}): TrailView {
  return {
    id,
    time,
    date: 'Thursday, Jun 11',
    dayKey: '2026-06-11',
    tone: 'done',
    actor: 'hale',
    summary,
    noun: 'draft',
    link: '/approvals',
    childLabel: null,
    teenRedacted: false,
    actionId: ACTION_ID,
    reversalKept: false,
    ...over,
  };
}

describe('TrailTimeline — an action’s lifecycle folds into one disclosure', () => {
  const html = renderToStaticMarkup(
    h(TrailTimeline, {
      entries: [
        step('e3', '16:31', 'put something on your calendar', { reversalKept: true }),
        step('e2', '16:30', 'you approved the action', { actor: 'you' }),
        step('e1', '16:02', 'drafted an action for you', { tone: 'coach' }),
      ],
    }),
  );

  it('summarises with where the action GOT TO, and says how many steps there were', () => {
    expect(html).toContain('<details');
    expect(html).toContain('put something on your calendar');
    expect(html).toContain('3 steps on this one');
  });

  it('anchors the trace on the action id, so /trail#<action-id> lands on it', () => {
    expect(html).toContain(`id="${ACTION_ID}"`);
  });

  it('keeps every step’s own audit anchor, so the M9 row deep links still resolve', () => {
    for (const id of ['e1', 'e2', 'e3']) {
      expect(html).toContain(`id="${id}"`);
    }
  });

  it('reads the steps FORWARD inside, though the timeline is ordered newest-first', () => {
    const body = html.slice(html.indexOf('trace-steps'));
    expect(body.indexOf('drafted an action for you')).toBeLessThan(
      body.indexOf('you approved the action'),
    );
    expect(body.indexOf('you approved the action')).toBeLessThan(
      body.indexOf('put something on your calendar'),
    );
  });

  it('says a placement can still be taken back, without printing the handle', () => {
    expect(html).toContain('Hale kept a way to take this back');
    expect([...html.matchAll(/Hale kept a way to take this back/g)]).toHaveLength(1);
  });

  it('leaves an unrelated row as a plain entry, not an empty disclosure', () => {
    const loose = renderToStaticMarkup(
      h(TrailTimeline, {
        entries: [step('e9', '11:00', 'you added a plan', { actionId: null, noun: 'plan' })],
      }),
    );
    expect(loose).not.toContain('<details');
    expect(loose).toContain('you added a plan');
    // A standalone row keeps its "view this <noun>" link; a folded trace does not
    // offer one per step, because the summary already links the action.
    expect(loose).toContain('view this plan');
  });
});
