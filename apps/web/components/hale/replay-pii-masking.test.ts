import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { companionForChild } from '@hale/types';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ToolCard } from '@hale/agent';
import type { TrailView } from '~/lib/dashboard/mappers';
import { AccountMenuView } from './account-menu-view';
import { GrowthSection, OverviewSection, RoutinesSection } from './companion-tabs';
import { ConnectorCard } from './connector-card';
import { TrailTimeline } from './trail-timeline';

// companion-tabs pulls done-button → the 'use server' log module; stub it so a
// static render doesn't drag the auth/db chain into the test.
vi.mock('~/lib/companion/log', () => ({ markCompanionItemDone: vi.fn() }));

/**
 * Replay-masking regression guard (hard rule #1). PostHog session replay records
 * the live DOM and masks rendered text ONLY inside an element tagged
 * `[data-hale-pii]` (rrweb cascades the mask to that element's descendants —
 * POSTHOG_PII_SELECTOR in posthog-provider). So every on-screen child/family PII
 * field MUST sit under such an element, or the replay captures it as cleartext.
 *
 * The check is structural, not a substring: `stripMaskedSubtrees` excises the
 * full subtree of every `data-hale-pii` element from the rendered HTML, then we
 * assert the PII value is GONE from what remains. A field rendered outside any
 * tagged ancestor survives the strip and fails the test — which is exactly the
 * leak we are guarding against. (Removing a tag in the source turns these red;
 * see the red-before-green note in the PR.)
 */

/**
 * Remove the entire subtree of each element carrying `data-hale-pii`, leaving the
 * residual markup a replay would expose as readable text. Walks the tag stream
 * tracking depth so a nested same-name element can't close the masked region
 * early.
 */
function stripMaskedSubtrees(html: string): string {
  let out = '';
  let i = 0;
  while (i < html.length) {
    const open = html.indexOf('data-hale-pii', i);
    if (open === -1) {
      out += html.slice(i);
      break;
    }
    const tagStart = html.lastIndexOf('<', open);
    const tagName = /^<([a-zA-Z][\w-]*)/.exec(html.slice(tagStart))?.[1];
    if (!tagName) {
      out += html.slice(i, open + 'data-hale-pii'.length);
      i = open + 'data-hale-pii'.length;
      continue;
    }
    out += html.slice(i, tagStart);

    const openRe = new RegExp(`<${tagName}(\\s|>)`, 'g');
    const closeTag = `</${tagName}>`;
    let depth = 0;
    let cursor = tagStart;
    while (cursor < html.length) {
      openRe.lastIndex = cursor;
      const nextOpen = openRe.exec(html);
      const nextClose = html.indexOf(closeTag, cursor);
      if (nextClose === -1) {
        cursor = html.length;
        break;
      }
      if (nextOpen && nextOpen.index < nextClose) {
        depth += 1;
        cursor = nextOpen.index + 1;
        continue;
      }
      depth -= 1;
      cursor = nextClose + closeTag.length;
      if (depth === 0) break;
    }
    i = cursor;
  }
  return out;
}

describe('stripMaskedSubtrees (the test harness itself)', () => {
  it('removes a tagged subtree, including nested same-name children', () => {
    const html = renderToStaticMarkup(
      h(
        'div',
        null,
        h('div', { 'data-hale-pii': true }, h('div', null, 'SECRET')),
        h('p', null, 'visible'),
      ),
    );
    const residue = stripMaskedSubtrees(html);
    expect(residue).not.toContain('SECRET');
    expect(residue).toContain('visible');
  });
});

describe('account chip (every authed page) masks the parent identity', () => {
  const PARENT = 'Priya Raman';

  const html = renderToStaticMarkup(
    h(AccountMenuView, {
      open: false,
      parentName: PARENT,
      planTier: 'free',
      canSignOut: true,
      menuId: 'm',
      onToggle: () => {},
      onSelect: () => {},
      onSignOut: () => {},
    }),
  );

  it('renders the identity at all (guards against a vacuous pass)', () => {
    expect(html).toContain(PARENT);
  });

  it('keeps the parent name inside a [data-hale-pii] subtree', () => {
    const residue = stripMaskedSubtrees(html);
    expect(residue).not.toContain(PARENT);
  });
});

describe('history timeline masks each entry summary + child name', () => {
  const entries: TrailView[] = [
    {
      id: 'e1',
      time: '14:30',
      date: 'Thursday, Jun 11',
      dayKey: '2026-06-11',
      tone: 'done',
      actor: 'hale',
      summary: 'carried out the action for Maya',
      noun: 'draft',
      link: '/approvals',
      childLabel: 'Maya',
    },
  ];

  const html = renderToStaticMarkup(h(TrailTimeline, { entries }));

  it('renders the entry text at all (guards against a vacuous pass)', () => {
    expect(html).toContain('Maya');
  });

  it('keeps the entry summary and the child name inside a [data-hale-pii] subtree', () => {
    const residue = stripMaskedSubtrees(html);
    // The summary sentence and the attributed child's name are both masked.
    expect(residue).not.toContain('Maya');
    // The non-PII frame — day heading, the deep link — survives the strip.
    expect(residue).toContain('Thursday, Jun 11');
    expect(residue).toContain('view this draft');
  });
});

describe('companion growth section masks the measurement readings', () => {
  const child = {
    id: 'c-1',
    dateOfBirth: '2025-06-01',
    ...companionForChild({ dateOfBirth: '2025-06-01', name: 'Noor' }),
  };
  // A unique reading string so the assertion can't pass on incidental markup.
  const growthLogs = [
    {
      id: 'g1',
      childId: 'c-1',
      episodeType: 'measurement',
      summary: '7.3 kg',
      occurredAt: '2026-06-01T10:00:00.000Z',
      measureKind: 'weight',
      value: 7.3,
      unit: 'kg',
    },
  ];
  const html = renderToStaticMarkup(
    h(GrowthSection, { child, growthLogs, stats: [], units: 'metric', timeZone: 'America/Toronto' }),
  );

  it('renders the reading at all (guards against a vacuous pass)', () => {
    expect(html).toContain('7.3 kg');
  });

  it('keeps each measurement reading inside a [data-hale-pii] subtree', () => {
    const residue = stripMaskedSubtrees(html);
    expect(residue).not.toContain('7.3 kg');
    // The non-PII frame — the WHO data-source disclaimer — survives the strip.
    expect(residue).toContain('WHO Child Growth Standards');
  });
});

describe('companion overview section masks the child name + a scheduled health item', () => {
  // A newborn so nextHealth populates the HEALTH SCHEDULE card rows (mockup panel 2).
  const child = {
    id: 'c-1',
    dateOfBirth: '2026-05-01',
    ...companionForChild({ dateOfBirth: '2026-05-01', name: 'Noor' }),
  };
  const html = renderToStaticMarkup(
    h(OverviewSection, {
      child,
      recentLogs: [],
      members: { primary: null, coParent: null },
      viewerEmail: null,
      timeZone: 'America/Toronto',
      onNavigate: () => {},
    }),
  );

  it('renders the child name + a scheduled health item at all (guards against a vacuous pass)', () => {
    // The insight card personalizes with the first name; the health summary leads with
    // the child's next scheduled visit — both are the child-identifying fields.
    expect(html).toContain('Noor');
    expect(html).toContain('well-baby visit');
  });

  it('keeps the child name and the health item inside a [data-hale-pii] subtree', () => {
    const residue = stripMaskedSubtrees(html);
    expect(residue).not.toContain('Noor');
    expect(residue).not.toContain('well-baby visit');
    // The non-PII frame — the card eyebrows + in-card links — survives the strip.
    expect(residue).toContain('health summary');
    expect(residue).toContain('View health records');
  });
});

describe('companion routines section masks a routine item title + note', () => {
  const routine = {
    id: 'r-1',
    weekOf: '2026-06-15',
    items: [
      {
        title: 'Swim lessons at the Y',
        kind: 'activity',
        stageNote: 'builds water confidence',
        day: 'saturday',
        teenAttributed: false,
      },
    ],
  };
  const html = renderToStaticMarkup(h(RoutinesSection, { routine }));

  it('renders the routine item at all (guards against a vacuous pass)', () => {
    expect(html).toContain('Swim lessons at the Y');
  });

  it('keeps the item title and stage note inside a [data-hale-pii] subtree', () => {
    const residue = stripMaskedSubtrees(html);
    expect(residue).not.toContain('Swim lessons at the Y');
    expect(residue).not.toContain('builds water confidence');
    // The non-PII frame — the kind pill + the day — survives the strip.
    expect(residue).toContain('activity');
    expect(residue).toContain('saturday');
  });
});

/**
 * The connector cards surface the PARENT's own Google Drive file names and Calendar
 * event titles/locations — family PII that a session replay must mask (rule #1). The
 * card FRAME (the "Google Drive" header, the file-type label, the day/time) is not
 * PII and should survive. This fails if a future edit moves a file name / event
 * title / location out of its `data-hale-pii` container.
 */
describe('connector cards mask the parent’s file names + event details', () => {
  const DRIVE_CARD: ToolCard = {
    kind: 'drive',
    files: [
      {
        name: 'Custody agreement 2026.pdf',
        mimeType: 'application/pdf',
        modifiedTime: '2026-07-01T09:00:00Z',
        webViewLink: 'https://drive.google.com/file/d/abc/view',
      },
    ],
  };
  const CALENDAR_CARD: ToolCard = {
    kind: 'calendar',
    events: [
      {
        title: 'Family therapy — Dr. Okafor',
        start: '2026-07-11T14:00:00Z',
        end: '2026-07-11T15:00:00Z',
        location: '221 Bloor St W',
      },
    ],
  };

  it('renders the Drive file name at all, then masks it while the frame survives', () => {
    const html = renderToStaticMarkup(h(ConnectorCard, { card: DRIVE_CARD }));
    expect(html).toContain('Custody agreement 2026.pdf');
    const residue = stripMaskedSubtrees(html);
    expect(residue).not.toContain('Custody agreement 2026.pdf');
    // The non-PII frame survives the strip.
    expect(residue).toContain('Google Drive');
    expect(residue).toContain('PDF');
  });

  it('renders the Calendar title + location at all, then masks both while the frame survives', () => {
    const html = renderToStaticMarkup(h(ConnectorCard, { card: CALENDAR_CARD }));
    expect(html).toContain('Family therapy');
    expect(html).toContain('221 Bloor St W');
    const residue = stripMaskedSubtrees(html);
    expect(residue).not.toContain('Family therapy');
    expect(residue).not.toContain('221 Bloor St W');
    expect(residue).toContain('Next 7 days');
  });
});

/**
 * The approvals row is inline JSX on the server page (it loads its drafts from the
 * DB, so it can't be rendered with a fixture without standing up the query layer).
 * Guard it at the source instead: the row's PII-bearing expressions — the human
 * preview, the verdict summary, and the drafted-payload detail — must each sit
 * after a `data-hale-pii` marker so the replay masks the row body. This fails if a
 * future edit moves any of these fields out of the tagged container.
 */
describe('approvals page source tags the row body PII', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../../app/(authed)/approvals/page.tsx', import.meta.url)),
    'utf8',
  );

  const piiExpressions = [
    '{approval.preview}',
    'detail={approval.summary}',
    '{approval.summary}',
    'payload={approval.payload}',
  ];

  it('each row-body PII field appears after the data-hale-pii marker', () => {
    const marker = source.indexOf('data-hale-pii');
    expect(marker).toBeGreaterThan(-1);
    for (const expr of piiExpressions) {
      const at = source.indexOf(expr);
      expect(at, `${expr} should be present`).toBeGreaterThan(-1);
      expect(at, `${expr} should be inside the data-hale-pii container`).toBeGreaterThan(marker);
    }
  });
});
