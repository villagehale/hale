import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { WeekPlan } from '@hale/db';
import type { TrailView } from '~/lib/dashboard/mappers';
import { TrailTimeline } from './trail-timeline';
import { WeekPlanCard, WeekPlanToday, type WeekPlanKid } from './week-plan-card';

/**
 * VIL-244 · M9 — the receipts-room reframe (D4/D20), behind F14_RECEIPTS_IA.
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
  const src = app('(authed)/approvals/page.tsx');

  it('anchors each row on the draft action id', () => {
    expect(src).toContain('id={approval.id}');
  });

  it('still shows WHAT was proposed and WHEN it was drafted', () => {
    expect(src).toContain('{approval.preview}');
    expect(src).toContain('drafted {approval.draftedAt}');
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

  it('forwards /home to the week view as a real 302, in the middleware', () => {
    expect(middleware).toContain('receiptsIaEnabled()');
    expect(middleware).toContain("NextResponse.redirect(new URL('/plan', req.nextUrl), 302)");
  });

  it('forwards the sub-paths too, so no bookmark under /home escapes the demotion', () => {
    expect(middleware).toContain("pathname === '/home' || pathname.startsWith('/home/')");
  });

  it('leaves the feed page itself intact — its removal is a later PR, and flag-off must still render it', () => {
    expect(page).toContain('HomeChildPanels');
    expect(page).not.toContain('receiptsIaEnabled');
  });
});

describe('sign-in ordering', () => {
  const src = app('sign-in/page.tsx');

  it('leads with the emailed link behind the flag, Google second', () => {
    expect(src).toContain('const linkFirst = receiptsIaEnabled();');
    expect(src).toContain('{linkFirst ? magicLinkForm : googleButton}');
    expect(src).toContain('{linkFirst ? googleButton : magicLinkForm}');
  });

  it('moves presentation only — the providers and the callback are untouched', () => {
    expect(src).toContain("await signIn('google', { redirectTo })");
    expect(src).toContain('callbackUrl={redirectTo}');
    expect(src).not.toContain('type="password"');
  });
});

describe('the authed shell resolves the flag server-side', () => {
  const src = app('(authed)/layout.tsx');

  it('reads it once and hands both nav consumers the same boolean', () => {
    expect(src).toContain('const receiptsIa = receiptsIaEnabled();');
    expect(src).toContain('receiptsIa={receiptsIa}');
    expect(src).toContain('<TopHeader receiptsIa={receiptsIa} />');
  });

  it('keeps the flag out of the client modules that render the nav', () => {
    for (const rel of ['sidebar.tsx', 'top-header.tsx', 'nav.ts']) {
      const client = readFileSync(fileURLToPath(new URL(`./${rel}`, import.meta.url)), 'utf8');
      // A server-only variable read from a client module resolves to undefined in the
      // browser bundle, so the two renders would disagree.
      expect(client).not.toContain('process.env');
      expect(client).not.toContain('receiptsIaEnabled');
    }
  });
});
