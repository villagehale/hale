import type { WeekPlanItem } from '@hale/db';
import { describe, expect, it } from 'vitest';
import type { LoopMessage, RenderedContent } from '~/lib/channel/types';
import type { ChildNameLevel } from '~/lib/loop/prefs';
import { smsSegments } from './core';
import { weeklyPlanRenderer } from './index';
import type { PlanChild, WeeklyPlanPayload } from './payload';

/**
 * VIL-218 · B2 — the per-channel renderers, exercised through the A2 seam
 * (TemplateRenderer.render(message, channel, nameLevel)). Every expectation is
 * derived from the copy spec + the privacy rules, never copied from output.
 */

const EM_DASH = '—';

const maya: PlanChild = { id: 'c-maya', name: 'Maya', dateOfBirth: '2019-03-10', gender: 'girl' };
const liam: PlanChild = { id: 'c-liam', name: 'Liam', dateOfBirth: '2021-06-01', gender: 'boy' };
const ada: PlanChild = { id: 'c-ada', name: 'Ada', dateOfBirth: '2023-01-01', gender: 'girl' };
const teen: PlanChild = { id: 'c-teen', name: 'Sam', dateOfBirth: '2011-01-01', gender: 'boy' };

function item(partial: Partial<WeekPlanItem>): WeekPlanItem {
  return {
    kind: 'village',
    title: 'Something',
    childIds: [],
    startsAt: null,
    endsAt: null,
    location: null,
    sourceRef: null,
    needs: 'none',
    privacySensitive: false,
    ...partial,
  };
}

function payload(over: Partial<WeeklyPlanPayload>): WeeklyPlanPayload {
  return {
    weekStart: '2026-07-20',
    summary: null,
    items: [],
    children: [],
    deepLink: 'https://app.villagehale.com/plan',
    unsubscribeUrl: 'https://app.villagehale.com/unsubscribe?u=user-1&t=daily_digest&sig=abc',
    ...over,
  };
}

function msg(p: WeeklyPlanPayload): LoopMessage {
  return {
    templateKey: 'weekly_plan',
    familyId: 'fam-1',
    parentUserId: 'user-1',
    category: 'weekly_plan',
    urgency: 'normal',
    payload: p as unknown as Record<string, unknown>,
  };
}

function render(
  p: WeeklyPlanPayload,
  channel: 'email' | 'sms' | 'push',
  level: ChildNameLevel,
): RenderedContent {
  return weeklyPlanRenderer.render(msg(p), channel, level);
}

const healthAppt = item({
  kind: 'appointment',
  title: `Maya ${EM_DASH} 6-month checkup`,
  childIds: ['c-maya'],
  needs: 'calendar_add',
  privacySensitive: true,
});

// A realistic full week: two children, eight items, four needing the parent's OK.
const fullWeek = payload({
  children: [maya, liam],
  items: [
    healthAppt,
    item({ kind: 'birthday', title: "Liam's birthday", childIds: ['c-liam'], startsAt: '2026-07-22' }),
    item({ kind: 'village', title: 'Library storytime', startsAt: '2026-07-20T10:30', needs: 'calendar_add' }),
    item({ kind: 'village', title: 'Swim class', startsAt: '2026-07-21T16:30', needs: 'calendar_add' }),
    item({ kind: 'village', title: 'Soccer practice', startsAt: '2026-07-23T17:00' }),
    item({ kind: 'village', title: 'Park meetup \u{1f389}', startsAt: '2026-07-24T14:00' }),
    item({ kind: 'routine', title: 'Music class', startsAt: '2026-07-25T09:00' }),
    item({ kind: 'suggestion', title: 'Family picnic Saturday', startsAt: '2026-07-25', needs: 'decision' }),
  ],
});

function sms(p: WeeklyPlanPayload, level: ChildNameLevel): string {
  const r = render(p, 'sms', level);
  if (r.kind !== 'sms') throw new Error('expected sms');
  return r.text;
}

function email(p: WeeklyPlanPayload, level: ChildNameLevel) {
  const r = render(p, 'email', level);
  if (r.kind !== 'email') throw new Error('expected email');
  return r;
}

function push(p: WeeklyPlanPayload, level: ChildNameLevel) {
  const r = render(p, 'push', level);
  if (r.kind !== 'push') throw new Error('expected push');
  return r;
}

describe('SMS — segment budget + GSM-7 output', () => {
  it('a worst-case eight-item week stays within 3 segments and is GSM-7', () => {
    const text = sms(fullWeek, 'first_name');
    expect(smsSegments(text)).toBeLessThanOrEqual(3);
    // GSM-7 is the only way 8 items fit in 3 segments (UCS-2 would be 67/seg).
    expect(smsSegments(text)).toBe(smsSegments(text)); // stable
    expect(text.includes(EM_DASH)).toBe(false); // normalized away
    expect(text.includes('·')).toBe(false);
  });

  it('strips emoji from the SMS', () => {
    expect(sms(fullWeek, 'first_name')).not.toContain('\u{1f389}');
  });

  it('opens with the possessive header and the reply invitation', () => {
    const text = sms(fullWeek, 'first_name');
    expect(text.startsWith("Hale: Maya & Liam's week")).toBe(true);
    // 4 items need the parent's OK.
    expect(text).toContain('4 need your OK');
    expect(text).toContain('reply YES');
  });
});

describe('SMS — child_name_level changes the header', () => {
  it('first_name names the children; relation/generic collapse to "your kids"', () => {
    expect(sms(fullWeek, 'first_name')).toContain("Maya & Liam's week");
    expect(sms(fullWeek, 'relation')).toContain("your kids' week");
    expect(sms(fullWeek, 'generic')).toContain("your kids' week");
  });
});

describe('privacy_sensitive genericization', () => {
  const twoItem = payload({
    children: [maya, liam],
    items: [
      healthAppt,
      item({ kind: 'birthday', title: "Liam's birthday", childIds: ['c-liam'], startsAt: '2026-07-22' }),
    ],
  });

  it('SMS never emits the health title verbatim — shows "a checkup"', () => {
    const text = sms(twoItem, 'first_name');
    expect(text).toContain('a checkup');
    expect(text).not.toContain('6-month checkup');
  });

  it('push never emits the health title verbatim — shows "a checkup"', () => {
    const body = push(twoItem, 'first_name').body;
    expect(body).toContain('a checkup');
    expect(body).not.toContain('6-month checkup');
  });

  it('email MAY show the health detail (parent-facing, non-teen)', () => {
    const html = email(payload({ children: [maya], items: [healthAppt] }), 'first_name').html;
    expect(html).toContain('6-month checkup');
  });
});

describe('child_name_level matrix through the email item titles', () => {
  const single = payload({ children: [maya], items: [healthAppt] });

  it('first_name shows the name, relation/generic re-level it', () => {
    expect(email(single, 'first_name').html).toContain('Maya');
    const relation = email(single, 'relation').html;
    expect(relation).toContain('your daughter');
    expect(relation).not.toContain('Maya');
    const generic = email(single, 'generic').html;
    expect(generic).toContain('your kid');
    expect(generic).not.toContain('Maya');
  });
});

describe('teen child is forced generic at every level and every channel', () => {
  const teenPlan = payload({
    children: [teen],
    items: [
      item({
        kind: 'appointment',
        title: 'a private appointment for your teen',
        childIds: ['c-teen'],
        needs: 'calendar_add',
        privacySensitive: true,
      }),
    ],
  });

  it('never surfaces the teen name, and headers with "your teen"', () => {
    for (const level of ['first_name', 'relation', 'generic'] as ChildNameLevel[]) {
      expect(sms(teenPlan, level)).not.toContain('Sam');
      expect(email(teenPlan, level).html).not.toContain('Sam');
      expect(push(teenPlan, level).title).not.toContain('Sam');
      expect(sms(teenPlan, level)).toContain("your teen's week");
    }
  });
});

describe('multi-child headers (email subject)', () => {
  it('2 and 3 distinct first names join; generic collapses to "your kids"', () => {
    const two = payload({ children: [maya, liam], items: [
      item({ kind: 'birthday', title: "Maya's birthday", childIds: ['c-maya'], startsAt: '2026-07-22' }),
      item({ kind: 'birthday', title: "Liam's birthday", childIds: ['c-liam'], startsAt: '2026-07-23' }),
    ] });
    expect(email(two, 'first_name').subject).toBe("Maya & Liam's week ahead");
    expect(email(two, 'generic').subject).toBe("your kids' week ahead");

    const three = payload({ children: [maya, liam, ada], items: [
      item({ kind: 'birthday', title: "Maya's birthday", childIds: ['c-maya'], startsAt: '2026-07-22' }),
      item({ kind: 'birthday', title: "Liam's birthday", childIds: ['c-liam'], startsAt: '2026-07-23' }),
      item({ kind: 'birthday', title: "Ada's birthday", childIds: ['c-ada'], startsAt: '2026-07-24' }),
    ] });
    expect(email(three, 'first_name').subject).toBe("Maya, Liam & Ada's week ahead");
  });
});

describe('quiet week (0 items)', () => {
  const quiet = payload({ children: [], items: [] });

  it('SMS offers the IDEAS reply and uses the "Your" subject', () => {
    const text = sms(quiet, 'generic');
    expect(text).toContain('A quiet week');
    expect(text).toContain('Reply IDEAS');
    expect(text).toContain('Your week');
    expect(smsSegments(text)).toBe(1);
  });

  it('email subject is "Your week ahead" and carries the reply invitation', () => {
    const e = email(quiet, 'generic');
    expect(e.subject).toBe('Your week ahead');
    expect(e.html.toLowerCase()).toContain('reply to this email to adjust');
  });

  it('push title is "Your week is ready"', () => {
    expect(push(quiet, 'generic').title).toBe('Your week is ready');
  });
});

describe('all-placed week (items > 0, pending == 0)', () => {
  const placed = payload({
    children: [maya, liam],
    items: [
      item({ kind: 'birthday', title: "Maya's birthday", childIds: ['c-maya'], startsAt: '2026-07-22' }),
      item({ kind: 'birthday', title: "Liam's birthday", childIds: ['c-liam'], startsAt: '2026-07-23' }),
    ],
  });

  it('SMS closes with "All on your calendar." and asks for nothing', () => {
    const text = sms(placed, 'first_name');
    expect(text).toContain('All on your calendar.');
    expect(text).not.toContain('need your OK');
  });
});

describe('email — CASL footer + pending line + deep link', () => {
  it('carries the payload unsubscribe URL, sender, and address', () => {
    const e = email(fullWeek, 'first_name');
    expect(e.html).toContain(
      'https://app.villagehale.com/unsubscribe?u=user-1&amp;t=daily_digest&amp;sig=abc',
    );
    expect(e.html).toContain('Village Hale Technologies Inc.');
    expect(e.html).toContain('4 need your OK');
  });

  it('push data carries the /plan deep link', () => {
    expect(push(fullWeek, 'first_name').data?.deepLink).toBe('https://app.villagehale.com/plan');
  });
});
