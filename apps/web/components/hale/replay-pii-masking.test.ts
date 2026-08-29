import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ToolCard } from '@hale/agent';
import type { LogsPage } from '~/lib/companion/logs-view';
import type { ActionReview } from '~/lib/dashboard/action-review';
import type { PendingApprovalView } from '~/lib/dashboard/approvals';
import type { HistoryView } from '~/lib/dashboard/history';
import type { TrailView } from '~/lib/dashboard/mappers';
import type { AuthoredPlanView } from '~/lib/plan/authored';
import { AccountMenuView } from './account-menu-view';
import { ReviewNote } from './action-progress';
import { ApprovalCard, ReversibleCard } from './approval-card';
import { AttachmentChip } from './ask-hale-thread';
import { ChildSwitcherView } from './child-switcher-view';
import { ConnectorCard } from './connector-card';
import { AreaRemoveControl } from './location-switcher';
import { LogsBrowser } from './logs-browser';
import { AuthoredPlanCard } from './plan-cards';
import { SharedLinkRow } from './shared-links';
import { TeenAccessGrants } from './teen-access-grants';
import { TrailTimeline } from './trail-timeline';

// The logs browser and the Ask composer reach the 'use server' log module for their
// writes; stub it so a static render doesn't drag the auth/db chain into the test.
vi.mock('~/lib/companion/log', () => ({
  markCompanionItemDone: vi.fn(),
  editQuickEpisode: vi.fn(),
  deleteQuickEpisode: vi.fn(),
  logQuickEpisode: vi.fn(),
}));
// Same reason for the teen-access revoke form's 'use server' action module.
vi.mock('~/app/(authed)/settings/teen-access-actions', () => ({
  revokeTeenAccessAction: vi.fn(),
}));
// Same reason for the plan cards' done/remove actions and the area switcher's.
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
      actionId: null,
      reversalKept: false,
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

/**
 * W5 — a lifecycle folds several audit rows into one `<details>`, so BOTH the
 * summary (the step the action got to) and the collapsed steps carry sentences a
 * replay must not read. A closed disclosure is no protection: rrweb records the DOM,
 * not the viewport, so the hidden steps are in the recording exactly as the open ones
 * would be.
 */
describe('a trail trace masks the folded step sentences as well as its summary', () => {
  const ACTION_ID = 'ac710000-0000-4000-8000-000000000009';
  const DRAFTED = 'drafted Maya’s swim lesson for your calendar';
  const EXECUTED = 'put Maya’s swim lesson on your calendar';

  const step = (id: string, time: string, summary: string): TrailView => ({
    id,
    time,
    date: 'Thursday, Jun 11',
    dayKey: '2026-06-11',
    tone: 'done',
    actor: 'hale',
    summary,
    noun: 'draft',
    link: '/approvals',
    childLabel: 'Maya',
    teenRedacted: false,
    actionId: ACTION_ID,
    reversalKept: false,
  });

  const html = renderToStaticMarkup(
    h(TrailTimeline, { entries: [step('e2', '16:31', EXECUTED), step('e1', '16:02', DRAFTED)] }),
  );

  it('folds the two rows into one anchored disclosure (guards against a vacuous pass)', () => {
    expect(html).toContain(`id="${ACTION_ID}"`);
    expect(html).toContain('2 steps on this one');
    // Both sentences render — the summary's, and the one only the open trace shows.
    expect(html).toContain(EXECUTED);
    expect(html).toContain(DRAFTED);
  });

  it('leaves neither sentence, nor the child name, outside a masked subtree', () => {
    const residue = visibleText(stripMaskedSubtrees(html));
    expect(residue).not.toContain(EXECUTED);
    expect(residue).not.toContain(DRAFTED);
    expect(residue).not.toContain('Maya');
    // The non-PII frame survives: the day heading and the step count.
    expect(residue).toContain('Thursday, Jun 11');
    expect(residue).toContain('2 steps on this one');
  });

  it('keeps every step individually anchored, so an M9 deep link still resolves', () => {
    expect(html).toContain('id="e1"');
    expect(html).toContain('id="e2"');
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
  /** W5: the reviewer's own sentence is prose ABOUT the family, written by a model
   * that can and does name the child — so it is PII like any other card body. */
  const REVIEWER_NOTE = 'Dr. Chen is already on the recipient list for Maya’s care.';

  const REVIEW: ActionReview = {
    note: REVIEWER_NOTE,
    checks: [
      { label: 'known recipient', ok: true, capUsd: null },
      { label: 'over your cap', ok: false, capUsd: 50 },
    ],
    steps: [
      { key: 'drafted', label: 'drafted', at: 'today at 8:04 am', tone: 'done' },
      { key: 'reviewed', label: 'verified', at: 'today at 8:05 am', tone: 'done' },
      { key: 'open', label: 'waiting on your yes', at: null, tone: 'awaiting' },
    ],
  };

  const approval: PendingApprovalView = {
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
    review: REVIEW,
  };

  it('leaves no preview, verdict summary, child name, drafted payload or reviewer note outside a masked subtree', () => {
    const residue = visibleText(
      stripMaskedSubtrees(renderToStaticMarkup(h(ApprovalCard, { approval }))),
    );
    for (const value of [PREVIEW, SUMMARY, PAYLOAD_BODY, REVIEWER_NOTE, 'Maya']) {
      expect(residue, `${value} must not survive the mask`).not.toContain(value);
    }
  });

  it('is a real check — the same values ARE in the unmasked render', () => {
    const html = renderToStaticMarkup(h(ApprovalCard, { approval }));
    for (const value of [PREVIEW, SUMMARY, PAYLOAD_BODY, REVIEWER_NOTE, 'Maya']) {
      expect(html).toContain(value);
    }
  });

  /**
   * Non-vacuity for the transparency block itself. The masking assertions above would
   * pass trivially if the rail and the checks silently stopped rendering, so pin that
   * they are on the card — including the spending cap, which is the one figure the
   * chips carry and only on the branch that actually stores it.
   *
   * They sit INSIDE the card's `data-hale-pii` wrapper and are therefore masked in a
   * replay too. That is deliberate: rule #1 is "default to most restrictive", and a
   * rung label is not worth a second, narrower masking boundary to keep readable.
   */
  it('renders the rail, the checks and the stored cap', () => {
    const html = renderToStaticMarkup(h(ApprovalCard, { approval }));
    for (const value of ['drafted', 'verified', 'waiting on your yes', 'known recipient']) {
      expect(html).toContain(value);
    }
    expect(html).toContain('over your cap');
    expect(html).toContain('$50');
    // The standalone "drafted <time>" line the rail replaced is gone, not doubled.
    expect(html).not.toContain('drafted today at 8:04 am');
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

/**
 * VIL-276 — the INVARIANT, after three tickets of instances. Everything above
 * guards one surface at a time; this sweep states the rule once: seed a surface
 * with family strings, render it, and let NO attribute value carry one. rrweb
 * records attributes verbatim, so `[data-hale-pii]` (a TEXT mask) cannot protect
 * them — which is why "put the row's content in an aria-label to disambiguate an
 * identical-looking control" keeps re-appearing as a leak. The fix is always the
 * same: the accessible name is assembled by REFERENCE (`aria-labelledby` at the
 * node that already holds the masked text), or the attribute is dropped because
 * visible text beside it already says the thing.
 *
 * Adding a surface here is the cheap way to keep a new page inside the rule. A
 * surface qualifies when it renders from plain fixtures — state-gated leaves are
 * exported so they can (SharedLinkRow, AreaRemoveControl, AttachmentChip).
 *
 * `maskAllInputs` covers <input>/<textarea> VALUES separately (posthog-provider),
 * so a form field holding what a parent typed is not this rule's business; every
 * other attribute is.
 */
const CHILD = 'Marisol';
const PLAN_TITLE = 'Sign Marisol up for Saturday swim';
const LOG_ROW = 'Fed 140 ml before the nap';
const SHARE_TITLE = 'the Marisol week plan';
const FILE_NAME = 'Marisol-immunization-record.pdf';
const AREA = 'Riverdale, Ontario';
const PARENT = 'Priya Raman';
const DRIVE_FILE = 'Custody-agreement-2026.pdf';
const REVIEWER_RATIONALE = 'The swim school is already on Marisol’s recipient list.';
const TRACE_STEP = 'put Marisol’s swim lesson on your calendar';

const PLAN: AuthoredPlanView = {
  id: 'p1',
  title: PLAN_TITLE,
  notes: null,
  scheduledFor: '2026-08-08',
  completedAt: null,
  childId: 'c1',
  childName: CHILD,
};

const LOGS: LogsPage = {
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

interface AttributeSurface {
  /** Reads as the failing test's name, so a red run says WHICH surface leaks. */
  name: string;
  /** The family strings this fixture is seeded with. */
  sentinels: string[];
  render: () => string;
}

const SENTINEL_SURFACES: AttributeSurface[] = [
  {
    name: 'the child switcher (sidebar, every authed page)',
    sentinels: [CHILD],
    render: () =>
      renderToStaticMarkup(
        h(ChildSwitcherView, {
          open: true,
          kids: [{ id: 'c1', name: CHILD, lastName: null, ageLabel: 'toddler', avatarUrl: null }],
          activeId: 'c1',
          menuId: 'kids',
          addHref: '/family',
          onToggle: () => {},
          onSelect: () => {},
        }),
      ),
  },
  {
    name: 'a parent-authored plan card (done + remove controls)',
    sentinels: [PLAN_TITLE, CHILD],
    render: () => renderToStaticMarkup(h(AuthoredPlanCard, { plan: PLAN })),
  },
  {
    name: 'a logs browser row (edit + remove controls)',
    sentinels: [LOG_ROW],
    render: () =>
      renderToStaticMarkup(h(LogsBrowser, { initial: LOGS, kids: [], units: 'metric' })),
  },
  {
    name: 'a shared-link row (revoke control)',
    sentinels: [SHARE_TITLE],
    render: () =>
      renderToStaticMarkup(
        h(SharedLinkRow, {
          link: { kind: 'activity', id: 's1', token: 'tok', title: SHARE_TITLE },
          onRevoked: () => {},
        }),
      ),
  },
  {
    name: 'a staged chat attachment (remove control)',
    sentinels: [FILE_NAME],
    render: () =>
      renderToStaticMarkup(
        h(AttachmentChip, {
          attachment: { id: 'f1', name: FILE_NAME, sizeBytes: 120_000, tone: 'sage' },
          onRemove: () => {},
        }),
      ),
  },
  {
    name: 'a saved family area (remove control)',
    sentinels: [AREA],
    render: () =>
      renderToStaticMarkup(h(AreaRemoveControl, { areaId: 'ar1', label: AREA, onRemoved: () => {} })),
  },
  {
    name: 'the account chip (sidebar, every authed page)',
    sentinels: [PARENT],
    render: () =>
      renderToStaticMarkup(
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
      ),
  },
  {
    // W5 — the reviewer's rationale is model-written prose about this family, and it
    // sits beside chips that are NOT PII, which is exactly the mix that has produced
    // an aria-label leak twice before.
    name: 'a reviewer note + its verification chips (approvals)',
    sentinels: [REVIEWER_RATIONALE],
    render: () =>
      renderToStaticMarkup(
        h(ReviewNote, {
          review: {
            note: REVIEWER_RATIONALE,
            checks: [{ label: 'known recipient', ok: true, capUsd: null }],
            steps: [],
          },
        }),
      ),
  },
  {
    // W5 — a folded lifecycle: the summary names the child, and so do the steps
    // inside the closed disclosure, which a recording keeps all the same.
    name: 'a trail trace (one action’s folded lifecycle)',
    sentinels: [TRACE_STEP],
    render: () =>
      renderToStaticMarkup(
        h(TrailTimeline, {
          entries: [0, 1].map((n) => ({
            id: `t${n}`,
            time: `1${n}:00`,
            date: 'Thursday, Jun 11',
            dayKey: '2026-06-11',
            tone: 'done' as const,
            actor: 'hale' as const,
            summary: TRACE_STEP,
            noun: 'draft',
            link: '/approvals',
            childLabel: CHILD,
            teenRedacted: false,
            actionId: 'ac710000-0000-4000-8000-00000000000a',
            reversalKept: n === 0,
          })),
        }),
      ),
  },
  {
    name: 'a Drive connector card',
    sentinels: [DRIVE_FILE],
    render: () =>
      renderToStaticMarkup(
        h(ConnectorCard, {
          card: {
            kind: 'drive',
            files: [
              {
                name: DRIVE_FILE,
                mimeType: 'application/pdf',
                modifiedTime: '2026-07-01T09:00:00Z',
                webViewLink: 'https://drive.google.com/file/d/abc/view',
              },
            ],
          },
        }),
      ),
  },
];

describe('no family string reaches a DOM attribute (rrweb records those verbatim)', () => {
  it.each(SENTINEL_SURFACES)('$name', ({ name, sentinels, render }) => {
    const html = render();
    // Non-vacuous: the fixture's family strings ARE on this surface, so an empty
    // attribute sweep means "masked properly", not "nothing rendered".
    for (const sentinel of sentinels) {
      expect(html, `${name}: the fixture must actually render "${sentinel}"`).toContain(sentinel);
    }
    const leaks = attributeValues(html).filter((value) =>
      sentinels.some((sentinel) => value.includes(sentinel)),
    );
    // The surface is named in the message so a multi-surface red run prints each
    // leak separately rather than collapsing identical-shaped failures into one.
    expect(leaks, `${name}: these attribute values would be recorded verbatim`).toEqual([]);
  });
});
