import { companionForChild } from '@hale/types';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ToolCard } from '@hale/agent';
import type { ApprovalView } from '~/lib/dashboard/approvals';
import type { HistoryView } from '~/lib/dashboard/history';
import type { TrailView } from '~/lib/dashboard/mappers';
import { AccountMenuView } from './account-menu-view';
import { ApprovalCard, ReversibleCard } from './approval-card';
import { GrowthSection, OverviewSection, RoutinesSection } from './companion-tabs';
import { ConnectorCard } from './connector-card';
import { TeenAccessGrants } from './teen-access-grants';
import { TrailTimeline } from './trail-timeline';

// companion-tabs pulls done-button → the 'use server' log module; stub it so a
// static render doesn't drag the auth/db chain into the test.
vi.mock('~/lib/companion/log', () => ({ markCompanionItemDone: vi.fn() }));
// Same reason for the teen-access revoke form's 'use server' action module.
vi.mock('~/app/(authed)/settings/teen-access-actions', () => ({
  revokeTeenAccessAction: vi.fn(),
}));

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
      teenRedacted: false,
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
    lastName: null,
    avatarUrl: null,
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
    lastName: null,
    avatarUrl: null,
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
 * The approvals row used to be inline JSX on the server page, so this guard could
 * only compare SOURCE offsets ("does `{approval.preview}` appear after the first
 * `data-hale-pii`?"). VIL-209 W3 extracted the row into `ApprovalCard`, which takes
 * a plain `ApprovalView` — so the guard is now the same STRUCTURAL check every
 * other block in this file uses: render the real card, excise the masked subtrees,
 * and assert nothing PII-bearing survives in what a replay would still read.
 */
/**
 * The consent surface needs BOTH halves of the check, because `maskTextSelector`
 * protects only TEXT NODES:
 *
 *  - `visibleText(stripMaskedSubtrees(html))` — what a replay still reads as text.
 *  - `attributeValues(html)` — every attribute value, on the FULL markup, because
 *    rrweb records attributes verbatim and a `[data-hale-pii]` ancestor does not
 *    protect one. This is the half that caught VIL-274: the approve / dismiss /
 *    undo buttons folded the draft preview into an `aria-label` to disambiguate
 *    otherwise-identical buttons in a list, which put the draft (child name and
 *    all) into a recording. They now carry an `aria-labelledby` REFERENCE to the
 *    row's preview node instead — same screen-reader name, no copy of the text.
 */
function visibleText(html: string): string {
  return html.replace(/<[^>]*>/g, ' ');
}

function attributeValues(html: string): string[] {
  return [...html.matchAll(/\s[a-zA-Z-]+="([^"]*)"/g)].flatMap((m) => m.slice(1));
}

describe('the approvals row body is masked for replay', () => {
  const PREVIEW = 'Reply to Dr. Chen — confirm Maya’s Tuesday 3pm';
  const SUMMARY = 'Hale matched this to Maya’s 18-month checkup';
  const PAYLOAD_BODY = 'Hi Dr. Chen — Tuesday at 3 works for Maya. Thank you!';

  const approval: ApprovalView = {
    id: 'a1',
    actionType: 'reply_to_email',
    summary: SUMMARY,
    preview: PREVIEW,
    payload: { to: 'clinic@example.com', subject: 'Tuesday', body: PAYLOAD_BODY },
    childId: 'c1',
    childLabel: 'Maya',
    verdict: 'approved',
    draftedAt: 'today at 8:04 am',
    teenRedacted: false,
    teenUnlockable: false,
  };

  it('leaves no preview, verdict summary, child name or drafted payload outside a masked subtree', () => {
    const residue = visibleText(
      stripMaskedSubtrees(renderToStaticMarkup(h(ApprovalCard, { approval }))),
    );
    for (const value of [PREVIEW, SUMMARY, PAYLOAD_BODY, 'Maya']) {
      expect(residue, `${value} must not survive the mask`).not.toContain(value);
    }
  });

  it('is a real check — the same values ARE in the unmasked render', () => {
    const html = renderToStaticMarkup(h(ApprovalCard, { approval }));
    for (const value of [PREVIEW, SUMMARY, PAYLOAD_BODY, 'Maya']) {
      expect(html).toContain(value);
    }
  });

  it('masks the needs-you branch too, where the summary rides the tone label', () => {
    const residue = stripMaskedSubtrees(
      renderToStaticMarkup(h(ApprovalCard, { approval: { ...approval, verdict: 'flagged' } })),
    );
    expect(residue).not.toContain(SUMMARY);
  });

  /**
   * VIL-274. The text mask is only half the surface: the approve / dismiss controls
   * need a per-row accessible name, and the obvious way to build one — folding the
   * preview into `aria-label` — writes the draft (child name and all) into an
   * attribute, which a replay keeps verbatim. The name must be assembled by
   * reference instead.
   */
  it('puts no draft text in ANY attribute — a replay records those verbatim', () => {
    const attrs = attributeValues(renderToStaticMarkup(h(ApprovalCard, { approval })));
    for (const value of [PREVIEW, SUMMARY, PAYLOAD_BODY, 'Maya']) {
      for (const attr of attrs) {
        expect(attr, `no attribute may carry "${value}"`).not.toContain(value);
      }
    }
  });
});

/**
 * The undo card is the other half of the consent surface and carries the same
 * preview through the same shape of control, so it gets the same two checks.
 */
describe('the still-reversible row is masked for replay', () => {
  const PREVIEW = 'Added Maya’s swim lesson to your calendar';

  const done: HistoryView = {
    id: 'h1',
    actionType: 'calendar_add',
    summary: 'Hale placed it on the family calendar',
    preview: PREVIEW,
    payload: { title: PREVIEW, start: '2026-08-11T14:00:00Z' },
    childId: 'c1',
    childLabel: 'Maya',
    verdict: 'approved',
    draftedAt: 'today at 8:04 am',
    teenRedacted: false,
    teenUnlockable: false,
    status: 'executed',
    resolvedAt: 'today at 8:06 am',
    undoable: true,
  };

  it('is a real check — the preview and child name ARE in the unmasked render', () => {
    const html = renderToStaticMarkup(h(ReversibleCard, { done }));
    expect(html).toContain(PREVIEW);
    expect(html).toContain('Maya');
  });

  it('leaves no preview or child name in a text node outside a masked subtree', () => {
    const residue = visibleText(stripMaskedSubtrees(renderToStaticMarkup(h(ReversibleCard, { done }))));
    expect(residue).not.toContain(PREVIEW);
    expect(residue).not.toContain('Maya');
  });

  it('puts no draft text in ANY attribute — the undo control names its row by id', () => {
    const attrs = attributeValues(renderToStaticMarkup(h(ReversibleCard, { done })));
    for (const value of [PREVIEW, 'Maya']) {
      for (const attr of attrs) {
        expect(attr, `no attribute may carry "${value}"`).not.toContain(value);
      }
    }
  });
});

/**
 * VIL-147 · the teen access section renders two things a replay must never
 * capture: the teen's name, and the parent's own words about why they want to
 * read their teen's messages. The second is the more sensitive of the pair — it
 * is a parent's stated worry about a specific child, shown back to them on a
 * settings page — so it has to sit inside a masked subtree like any other child
 * PII.
 */
describe('teen access grants mask the teen name and the parent\u2019s stated reason', () => {
  const TEEN_NAME = 'Maya';
  const REASON = 'worried about the group chat after school';

  const html = renderToStaticMarkup(
    h(TeenAccessGrants, {
      childNames: { 'child-1': TEEN_NAME },
      grants: [
        {
          id: '66666666-6666-4666-8666-666666666666',
          childId: 'child-1',
          scope: 'message_content' as const,
          reason: REASON,
          safetyEscalation: false,
          requestedAt: '2026-08-02T12:00:00.000Z',
          expiresAt: null,
          active: false,
          assented: false,
          revoked: false,
          teenNotified: false,
        },
      ],
    }),
  );

  it('renders both, and neither survives the mask strip', () => {
    expect(html).toContain(TEEN_NAME);
    expect(html).toContain(REASON);

    const residual = stripMaskedSubtrees(html);
    expect(residual).not.toContain(TEEN_NAME);
    expect(residual).not.toContain(REASON);
  });

  it('states plainly that nothing can be opened yet, rather than implying it can', () => {
    expect(html).toContain('Nothing can be opened yet');
    expect(html).toContain('no way to reach a teen');
    expect(html).toContain('waiting on your teen');
  });
});
