import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { WeekPlan } from '@hale/db';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { PendingApprovalView } from '~/lib/dashboard/approvals';
import type { TrailView } from '~/lib/dashboard/mappers';
import { ApprovalCard } from './approval-card';
import { TrailTimeline } from './trail-timeline';
import { WeekPlanCard, type WeekPlanKid, WeekPlanToday } from './week-plan-card';

/**
 * VIL-244 · M9 — the receipts-room reframe (D4/D20). The receipts IA is unconditional;
 * the F14_RECEIPTS_IA reader is gone.
 *
 * Two lanes, because the surfaces split two ways. The rows a channel message deep-links
 * (Trail) and the week arrangement are RENDERED here, so the assertions are about real
 * markup rather than the shape of the source. The redirect + ordering live in async
 * server components that pull in auth/db chains a unit test can't stand up, so those are
 * source scans — the same technique auth-passwordless.test.ts uses for /sign-in.
 */

vi.mock('next/navigation', () => ({ usePathname: () => '/trail' }));

const app = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../../app/${rel}`, import.meta.url)), 'utf8');

// ── Receipts affordances: what + when + a stable anchor ──────────────────────

function trailRow(overrides: Partial<TrailView> = {}): TrailView {
  return {
    id: '11111111-2222-3333-4444-555555555555',
    time: '09:14',
    date: 'Monday, Jul 6',
    dayKey: '2026-07-06',
    tone: 'done',
    actor: 'hale',
    summary: 'added Maya’s 18-month checkup to your calendar',
    noun: 'draft',
    link: '/approvals',
    childLabel: 'Maya',
    teenRedacted: false,
    actionId: null,
    reversalKept: false,
    ...overrides,
  };
}

describe('trail rows are deep-linkable receipts', () => {
  it('anchors each row on its audit_log id, so /trail#<id> resolves to the row', () => {
    const row = trailRow();
    const html = renderToStaticMarkup(h(TrailTimeline, { entries: [row] }));
    expect(html).toContain(`id="${row.id}"`);
  });

  it('each row still carries WHAT happened and WHEN, beside the anchor', () => {
    const row = trailRow();
    const html = renderToStaticMarkup(h(TrailTimeline, { entries: [row] }));
    expect(html).toContain(row.summary);
    expect(html).toContain(row.time);
    expect(html).toContain(row.date);
  });

  it('gives distinct rows distinct anchors (a shared anchor would deep-link the wrong receipt)', () => {
    const html = renderToStaticMarkup(
      h(TrailTimeline, {
        entries: [trailRow({ id: 'row-a' }), trailRow({ id: 'row-b', time: '10:02' })],
      }),
    );
    expect(html).toContain('id="row-a"');
    expect(html).toContain('id="row-b"');
  });
});

describe('approvals rows are deep-linkable receipts', () => {
  // VIL-209 W3 extracted the row into ApprovalCard, so these assert the RENDERED
  // row rather than the page's source text: the anchor an outbound message links
  // to, and the two facts a parent needs before deciding.
  const approval: PendingApprovalView = {
    id: 'act-42',
    actionType: 'reply_to_email',
    summary: 'verified by the reviewer — ready for your approval',
    preview: 'Reply to the clinic — confirm Tuesday 3pm',
    payload: null,
    childId: null,
    childLabel: null,
    verdict: 'approved',
    draftedAt: 'today at 8:04 am',
    teenRedacted: false,
    teenUnlockable: false,
    review: {
      note: 'The clinic is already on your recipient list.',
      checks: [{ label: 'known recipient', ok: true, capUsd: null }],
      steps: [
        { key: 'drafted', label: 'drafted', at: 'today at 8:04 am', tone: 'done' },
        { key: 'reviewed', label: 'verified', at: 'today at 8:05 am', tone: 'done' },
        { key: 'open', label: 'waiting on your yes', at: null, tone: 'awaiting' },
      ],
    },
  };
  const html = renderToStaticMarkup(h(ApprovalCard, { approval }));

  it('anchors each row on the draft action id', () => {
    expect(html).toContain('id="act-42"');
  });

  it('still shows WHAT was proposed and WHEN it was drafted', () => {
    expect(html).toContain('Reply to the clinic — confirm Tuesday 3pm');
    // The drafted stamp moved onto the status rail's first rung (W5) — same fact,
    // now with the rest of the lifecycle beside it.
    expect(html).toContain('>drafted<');
    expect(html).toContain('today at 8:04 am');
  });
});

// ── The week view's multi-kid arrangement ────────────────────────────────────

const MAYA: WeekPlanKid = {
  id: 'c-maya',
  name: 'Maya',
  dateOfBirth: '2018-04-02',
  stage: 'child',
};
const LIAM: WeekPlanKid = {
  id: 'c-liam',
  name: 'Liam',
  dateOfBirth: '2021-09-15',
  stage: 'toddler',
};
const RAE: WeekPlanKid = {
  id: 'c-rae',
  name: 'Rae',
  dateOfBirth: '2010-03-01',
  stage: 'teenager',
};

function plan(items: WeekPlan['items']): WeekPlan {
  return {
    id: 'plan-1',
    familyId: 'fam-1',
    weekStart: '2026-07-06',
    composedAt: new Date('2026-07-04T23:00:00Z'),
    summary: null,
    items,
    voice: null,
    status: 'composed',
  };
}

function planItem(overrides: Partial<WeekPlan['items'][number]> = {}): WeekPlan['items'][number] {
  return {
    kind: 'village',
    title: 'swim class',
    childIds: [],
    startsAt: '2026-07-06',
    endsAt: null,
    location: null,
    sourceRef: null,
    needs: 'none',
    privacySensitive: false,
    ...overrides,
  };
}

describe('week view multi-kid structure (flag on)', () => {
  it('labels a shared item Both and names each kid, oldest first', () => {
    const html = renderToStaticMarkup(
      h(WeekPlanCard, {
        plan: plan([
          planItem({ title: 'nap', childIds: [LIAM.id] }),
          planItem({ title: 'zoo', childIds: [MAYA.id, LIAM.id] }),
          planItem({ title: 'swim', childIds: [MAYA.id] }),
        ]),
        kids: [LIAM, MAYA],
      }),
    );
    expect(html.indexOf('>Maya<')).toBeGreaterThan(-1);
    expect(html.indexOf('>Maya<')).toBeLessThan(html.indexOf('>Liam<'));
    expect(html.indexOf('>Liam<')).toBeLessThan(html.indexOf('>Both<'));
  });

  it('never renders a 13+ kid’s name as the who-label (rule #1)', () => {
    const html = renderToStaticMarkup(
      h(WeekPlanCard, {
        plan: plan([planItem({ title: 'a checkup', childIds: [RAE.id] })]),
        kids: [RAE, MAYA],
      }),
    );
    expect(html).toContain('your teen');
    expect(html).not.toContain(RAE.name);
  });

  it('leaves the pre-M9 card untouched when no kids are passed (flag off)', () => {
    const items = [planItem({ title: 'swim', childIds: [MAYA.id] })];
    const off = renderToStaticMarkup(h(WeekPlanCard, { plan: plan(items) }));
    expect(off).toContain('swim');
    // No who-label at all: the pre-M9 card shows titles and provenance only.
    expect(off).not.toContain('Maya');
    expect(off).not.toContain('pill');
  });
});

describe('the Today strip (flag on)', () => {
  it('shows only what is dated today, grouped by kid', () => {
    const html = renderToStaticMarkup(
      h(WeekPlanToday, {
        plan: plan([
          planItem({ title: 'swim', childIds: [MAYA.id], startsAt: '2026-07-06' }),
          planItem({ title: 'library', childIds: [MAYA.id], startsAt: '2026-07-09' }),
        ]),
        kids: [MAYA, LIAM],
        todayKey: '2026-07-06',
      }),
    );
    expect(html).toContain('today');
    expect(html).toContain('swim');
    expect(html).not.toContain('library');
  });

  it('says so plainly on an empty day rather than rendering a hollow panel', () => {
    const html = renderToStaticMarkup(
      h(WeekPlanToday, {
        plan: plan([planItem({ title: 'library', startsAt: '2026-07-09' })]),
        kids: [MAYA],
        todayKey: '2026-07-06',
      }),
    );
    expect(html).toContain('nothing on today');
  });
});

// ── The flag-gated route + ordering changes ──────────────────────────────────

describe('the demoted daily feed', () => {
  const middleware = readFileSync(
    fileURLToPath(new URL('../../middleware.ts', import.meta.url)),
    'utf8',
  );
  const page = app('(authed)/home/page.tsx');

  it('leaves /home as the portal landing, and no longer forwards it to the week view', () => {
    expect(middleware).not.toContain('receiptsIaEnabled');
    expect(middleware).not.toContain("pathname === '/home'");
    expect(middleware).not.toContain("new URL('/plan'");
  });

  it('renders the portal home', () => {
    expect(page).toContain('PortalHome');
    expect(page).not.toContain('LegacyHomePage');
    expect(page).not.toContain('receiptsIaEnabled');
  });
});

describe('the family editor moved up a level (Instinct refresh)', () => {
  const middleware = readFileSync(
    fileURLToPath(new URL('../../middleware.ts', import.meta.url)),
    'utf8',
  );

  it('forwards /family/members to /family as a real 308, sub-paths included', () => {
    expect(middleware).not.toContain('receiptsIaEnabled');
    expect(middleware).toContain("NextResponse.redirect(new URL('/family', req.nextUrl), 308)");
    expect(middleware).toContain(
      "pathname === '/family/members' || pathname.startsWith('/family/members/')",
    );
  });

  it('the page itself permanentRedirects — defense in depth, the retired-routes pattern', () => {
    const page = app('(authed)/family/members/page.tsx');
    expect(page).toContain("permanentRedirect('/family')");
  });

  it('/family renders the editor content the members page used to own', () => {
    const page = app('(authed)/family/page.tsx');
    const portal = readFileSync(
      fileURLToPath(new URL('../portal/family-view.tsx', import.meta.url)),
      'utf8',
    );
    expect(page).toContain('PortalFamily');
    expect(page).not.toContain('LegacyFamilyPage');
    for (const editor of ['FamilyChildren', 'PortalIntents', 'AddCoParentCard']) {
      expect(portal).toContain(editor);
    }
    expect(portal).not.toContain('Founding family');
    expect(portal).not.toMatch(/foundingNumber|Founding family · #/);
    expect(portal).toContain('PostalEditor');
    expect(portal).not.toContain('FamilyLocation');
    expect(page).not.toContain('FamilyHubCard');
  });
});

describe('sign-in under the flag', () => {
  const src = app('sign-in/page.tsx');

  /**
   * The phone door does not read the flag. Flag-off used to render Google plus a
   * magic-link form. Those doors are gone, so unsetting the flag must not bring
   * a second entrance back. The render tests in auth-passwordless.test.ts prove
   * which affordances actually appear.
   */
  it('shows the phone path and does not branch on the receipts flag', () => {
    expect(src).toContain('<ClaimByPhoneForm');
    expect(src).toContain('callbackUrl={redirectTo}');
    expect(src).toContain('smsNumber={haleTextsNumber()}');
    expect(src).toContain('source={parsePortalSourceCode(s)}');
    expect(src).not.toContain('receiptsIaEnabled');
    expect(src).not.toContain('Continue with Google');
    expect(src).not.toContain('linkFirst');
    expect(src).not.toContain("signIn('google'");
    expect(src).not.toContain('type="password"');
  });
});

describe('the authed shell is the receipts portal', () => {
  const src = app('(authed)/layout.tsx');

  it('renders PortalShell and does not read the receipts flag', () => {
    expect(src).toContain('<PortalShell');
    expect(src).not.toContain('receiptsIaEnabled');
    expect(src).not.toContain('AppShell');
    expect(src).not.toContain('TopHeader');
  });

  it('keeps the flag out of the client nav module', () => {
    const client = readFileSync(fileURLToPath(new URL('./nav.ts', import.meta.url)), 'utf8');
    expect(client).not.toContain('process.env');
    expect(client).not.toContain('receiptsIaEnabled');
  });
});
