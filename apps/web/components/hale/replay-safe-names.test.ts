import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { LogsPage } from '~/lib/companion/logs-view';
import type { AuthoredPlanView } from '~/lib/plan/authored';
import { AttachmentChip } from './ask-hale-thread';
import { AreaRemoveControl } from './location-switcher';
import { LogsBrowser } from './logs-browser';
import { AuthoredPlanCard } from './plan-cards';
import { SharedLinkRow } from './shared-links';

vi.mock('~/lib/companion/log', () => ({
  editQuickEpisode: vi.fn(),
  deleteQuickEpisode: vi.fn(),
  logQuickEpisode: vi.fn(),
  markCompanionItemDone: vi.fn(),
}));
vi.mock('~/lib/plan/plan-actions', () => ({
  completePlan: vi.fn(),
  deletePlan: vi.fn(),
  createPlan: vi.fn(),
}));
vi.mock('~/lib/village/areas-action', () => ({
  activateAreaAction: vi.fn(),
  deleteAreaAction: vi.fn(),
  relocateToCityAction: vi.fn(),
  searchCitiesAction: vi.fn(),
}));

/**
 * The other half of VIL-276. Those controls all repeat per row — "mark done",
 * "revoke", a bare X — so the row's own content has to be in their accessible name
 * or a screen reader hears the same button N times. That name can no longer be an
 * `aria-label` copy (a replay records attributes verbatim), so it is assembled by
 * REFERENCE. These tests do what a screen reader does — resolve the reference — and
 * assert the resulting sentence, which is the check that would catch a dangling id
 * (a control with NO name at all) or a name that lost its verb.
 *
 * Mirrors approval-row-buttons.test.ts, which guards the same shape for the
 * approve / dismiss / undo controls fixed in VIL-274.
 */

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#x27;': "'",
};

function textContent(markup: string): string {
  return markup
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(?:amp|lt|gt|quot|#x27);/g, (entity) => ENTITIES[entity] ?? entity)
    .replace(/\s+/g, ' ')
    .trim();
}

/** The text of the element carrying `id`. Throws when the reference dangles — that
 * leaves the control with no accessible name at all, the regression this file
 * exists to catch. */
function textOfElement(html: string, id: string): string {
  const marker = html.indexOf(`id="${id}"`);
  if (marker === -1) throw new Error(`aria-labelledby points at #${id}, absent from the markup`);
  const tagName = /^<([a-zA-Z][\w-]*)/.exec(html.slice(html.lastIndexOf('<', marker)))?.[1];
  if (!tagName) throw new Error(`#${id} is not on an element`);
  const body = html.slice(html.indexOf('>', marker) + 1, html.indexOf(`</${tagName}>`, marker));
  return textContent(body);
}

/** The accessible name a screen reader computes for the button whose text contains
 * `visible`: each id in its `aria-labelledby`, in order, resolved to that element's
 * text; falling back to the button's own content when it names nothing. */
function accessibleName(html: string, visible: string): string {
  const button = [...html.matchAll(/<button\b[^>]*>.*?<\/button>/gs)]
    .map((match) => match[0])
    .find((markup) => textContent(markup).includes(visible));
  if (!button) throw new Error(`no button reads "${visible}"`);
  const refs = /aria-labelledby="([^"]*)"/.exec(button)?.[1];
  if (!refs) return textContent(button);
  return refs
    .split(' ')
    .map((id) => textOfElement(html, id))
    .join(' ');
}

const PLAN_TITLE = 'Sign Marisol up for Saturday swim';

const plan: AuthoredPlanView = {
  id: 'p1',
  title: PLAN_TITLE,
  notes: null,
  scheduledFor: '2026-08-08',
  completedAt: null,
  childId: 'c1',
  childName: 'Marisol',
};

const LOG_ROW = 'Fed 140 ml before the nap';

const logs: LogsPage = {
  logs: [
    {
      id: 'l1',
      childId: 'c1',
      episodeType: 'feed',
      summary: LOG_ROW,
      occurredAt: '2026-08-01T18:00:00.000Z',
    },
  ],
  nextCursor: null,
};

describe('per-row controls still name their row (VIL-276)', () => {
  it('names the plan card’s done + remove controls with their verb plus the plan', () => {
    const html = renderToStaticMarkup(h(AuthoredPlanCard, { plan }));
    expect(accessibleName(html, 'mark done')).toBe(`mark done ${PLAN_TITLE}`);
    expect(accessibleName(html, 'remove plan')).toBe(`remove plan ${PLAN_TITLE}`);
  });

  it('names a log row’s edit + remove controls with their verb plus the row', () => {
    const html = renderToStaticMarkup(h(LogsBrowser, { initial: logs, kids: [], units: 'metric' }));
    expect(accessibleName(html, 'edit log')).toBe(`edit log ${LOG_ROW}`);
    expect(accessibleName(html, 'remove log')).toBe(`remove log ${LOG_ROW}`);
  });

  it('names the revoke control with its visible text plus the shared link', () => {
    const html = renderToStaticMarkup(
      h(SharedLinkRow, {
        link: { kind: 'week_plan', id: 's1', token: 'tok', title: 'the Marisol week plan' },
        onRevoked: () => {},
      }),
    );
    expect(accessibleName(html, 'revoke')).toBe('revoke the Marisol week plan');
  });

  it('names the attachment chip’s remove control with the file it takes off the send', () => {
    const html = renderToStaticMarkup(
      h(AttachmentChip, {
        attachment: { id: 'f1', name: 'Marisol-record.pdf', sizeBytes: 120_000, tone: 'sage' },
        onRemove: () => {},
      }),
    );
    expect(accessibleName(html, 'Remove')).toBe('Remove Marisol-record.pdf');
  });

  it('names the saved-area remove control with the area it removes', () => {
    const html = renderToStaticMarkup(
      h(AreaRemoveControl, { areaId: 'ar1', label: 'Riverdale, Ontario', onRemoved: () => {} }),
    );
    // No reference to resolve here: the control owns its whole name as masked text,
    // because the visible label lives in the popover row above it.
    expect(accessibleName(html, 'Remove')).toBe('Remove Riverdale, Ontario');
  });

  it('gives two rows on one page two different names, and two different references', () => {
    const html = renderToStaticMarkup(
      h('div', null, [
        h(AuthoredPlanCard, { key: 'p1', plan }),
        h(AuthoredPlanCard, { key: 'p2', plan: { ...plan, id: 'p2', title: 'Book the 2-year visit' } }),
      ]),
    );
    expect(html).toContain('id="plan-p1-title"');
    expect(html).toContain('id="plan-p2-title"');
    const refs = [...html.matchAll(/aria-labelledby="([^"]*)"/g)].map((m) => m[1]);
    expect(new Set(refs).size).toBe(refs.length);
  });
});
