import type { WeekPlanItem } from '@hale/db';
import { describe, expect, it } from 'vitest';
import type { LoopMessage, RenderedContent } from '~/lib/channel/types';
import { isGsm7, smsSegments } from '~/lib/channel/sms-segments';
import type { ChildNameLevel } from '~/lib/loop/prefs';
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
    voice: null,
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

/**
 * The real worst case the SMS budget has to survive: the item cap full, every title a
 * long one taken from the registration corpus this product actually reads, and two
 * children whose names carry accents. The old fixture's longest title was "Family
 * picnic Saturday" — 22 characters — so the ≤3-segment guarantee was never tested
 * against anything that could break it.
 */
const denseWeek = payload({
  children: [
    { id: 'c-chloe', name: 'Chloé', dateOfBirth: '2019-03-10', gender: 'girl' },
    { id: 'c-loic', name: 'Loïc', dateOfBirth: '2021-06-01', gender: 'boy' },
  ],
  items: [
    item({ title: 'Community Leadership After-School Program (CLASP) 2026/2027 school year', childIds: ['c-chloe'], startsAt: '2026-07-20T09:00', needs: 'calendar_add' }),
    item({ title: 'After-School Recreation Care (ARC) 2026/2027 school year', childIds: ['c-loic'], startsAt: '2026-07-20T16:00', needs: 'calendar_add' }),
    item({ title: 'Fall 2026 and Winter 2027 Aquatic Leadership programs', childIds: ['c-chloe'], startsAt: '2026-07-21T17:15' }),
    item({ title: 'Holiday Camp (winter break) — registers in the Fall 2026 window', childIds: ['c-loic'], startsAt: '2026-07-22T10:30', needs: 'decision' }),
    item({ title: 'Fall 2026 (Learn to Swim and Learn to Skate)', childIds: ['c-chloe'], startsAt: '2026-07-23T18:45' }),
    item({ title: 'Fall 2026 and Winter 2027 youth programs', childIds: ['c-loic'], startsAt: '2026-07-24T08:15' }),
    item({ title: 'Fall 2026 Programs and Winter Camps', childIds: ['c-chloe'], startsAt: '2026-07-25T11:00', needs: 'calendar_add' }),
    item({ title: 'Winter Break Camps December 2026', childIds: ['c-loic'], startsAt: '2026-07-26T13:30' }),
  ],
});

describe('SMS — segment budget + GSM-7 output', () => {
  it('a worst-case eight-item week stays within 3 segments and is GSM-7', () => {
    const text = sms(fullWeek, 'first_name');
    expect(smsSegments(text)).toBeLessThanOrEqual(3);
    // GSM-7 is the only way 8 items fit in 3 segments (UCS-2 would be 67/seg).
    expect(isGsm7(text)).toBe(true);
    expect(text.includes(EM_DASH)).toBe(false); // normalized away
    expect(text.includes('·')).toBe(false);
  });

  it('holds the 3-segment budget on a full week of long real-world titles', () => {
    const text = sms(denseWeek, 'first_name');

    expect(smsSegments(text)).toBeLessThanOrEqual(3);
    expect(isGsm7(text)).toBe(true);
    // Whatever gives way, the ask never does — it is the only actionable line. Three
    // dated calendar_add items are drafted; the fourth pending item is a decision,
    // which no YES can answer, so it is not in the count the ask carries.
    expect(text).toContain('3 drafted for your calendar');
  });

  it('keeps accented names readable through the GSM-7 fold', () => {
    const text = sms(denseWeek, 'first_name');

    expect(text).toContain("Chloé & Loic's week");
  });

  it('strips emoji from the SMS', () => {
    expect(sms(fullWeek, 'first_name')).not.toContain('\u{1f389}');
  });

  it('opens with the possessive header and the reply invitation', () => {
    const text = sms(fullWeek, 'first_name');
    expect(text.startsWith("Hale: Maya & Liam's week")).toBe(true);
    expect(text).toContain('reply YES');
  });

  /**
   * The ask is a CONSENT instruction, so its count has to be the number of rows a YES
   * can actually resolve — the drafts the mint holds (dated `calendar_add` items), not
   * every item that asks something. fullWeek has four pending items but only two of
   * them become drafts: the undated checkup cannot be a calendar entry and the picnic
   * is a suggestion, and neither is approvable by text.
   */
  it('counts the DRAFTS a YES can answer, not every item that wants attention', () => {
    const text = sms(fullWeek, 'first_name');
    expect(text).toContain('2 drafted for your calendar');
    expect(text).not.toContain('4 ');
  });

  it('promises one-word approval only when ONE draft is waiting', () => {
    const one = payload({
      children: [maya],
      items: [item({ title: 'Swim class', startsAt: '2026-07-21T16:30', needs: 'calendar_add' })],
    });
    const text = sms(one, 'first_name');
    expect(text).toContain('1 drafted for your calendar');
    // Singular: "1 need your OK ... add them" was wrong twice in one sentence.
    expect(text).not.toContain('need your OK');
    expect(text).not.toContain('them');
    expect(text).toMatch(/reply YES to add it/i);
  });

  it('says a two-draft YES is answered one at a time — the router asks which', () => {
    // resolveApproval auto-approves a bare YES at exactly ONE pending row and otherwise
    // returns the numbered "Which one?" list, so "reply YES to add both" is a grammar
    // the router refuses. The ordinals are NOT quoted here on purpose: the pending list
    // is family-wide and oldest-first, so this week's drafts are not at positions 1..n.
    const text = sms(fullWeek, 'first_name');
    expect(text).toMatch(/reply YES and I'll take them one at a time/i);
    expect(text).not.toMatch(/YES 1|YES 2/);
    expect(text).not.toContain('both');
  });

  it('asks for nothing when the week has things to decide but nothing to approve', () => {
    // A suggestion and an undated checkup: real pending items, zero approvable rows.
    const undecidable = payload({
      children: [maya],
      items: [
        healthAppt,
        item({ kind: 'suggestion', title: 'Family picnic', startsAt: '2026-07-25', needs: 'decision' }),
      ],
    });
    const text = sms(undecidable, 'first_name');
    expect(text).not.toContain('reply YES');
    expect(text).not.toContain('drafted for your calendar');
    expect(text).not.toContain('All on your calendar.');
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

describe('VIL-229 voice — email uses voice fields, facts stay deterministic', () => {
  // healthAppt is items[0]; the birthday is items[1]. itemLines is keyed by index.
  const voiced = payload({
    children: [maya, liam],
    summary: 'a deterministic fallback sentence',
    items: [
      healthAppt,
      item({ kind: 'birthday', title: "Liam's birthday", childIds: ['c-liam'], startsAt: '2026-07-22' }),
    ],
    voice: {
      greeting: 'hi there, here is the week ahead',
      weekFraming: 'a calm week with one checkup to book and a birthday to enjoy',
      itemLines: { '0': 'a quick health check, nothing more', '1': 'a little one turns a year older' },
      signOff: 'reply any time — we read every note',
    },
  });

  it('renders greeting, framing, per-item lines, and sign-off in the email', () => {
    const html = email(voiced, 'first_name').html;
    expect(html).toContain('hi there, here is the week ahead');
    expect(html).toContain('a calm week with one checkup to book and a birthday to enjoy');
    expect(html).toContain('a quick health check, nothing more');
    expect(html).toContain('a little one turns a year older');
    expect(html).toContain('reply any time — we read every note');
    // The framing REPLACES the deterministic summary (voice.weekFraming ?? summary).
    expect(html).not.toContain('a deterministic fallback sentence');
  });

  it('keeps the deterministic facts (title, day, provenance) alongside the voice', () => {
    const html = email(voiced, 'first_name').html;
    expect(html).toContain('6-month checkup'); // the injected fact, not model-written
    expect(html).toContain('Liam');
  });

  it('falls back to the deterministic summary + reply invite when voice is null', () => {
    const html = email(payload({ children: [maya], items: [healthAppt], summary: 'quiet week note' }), 'first_name').html;
    expect(html).toContain('quiet week note');
    expect(html.toLowerCase()).toContain('reply to this email to adjust');
  });
});

describe('the pending heading agrees with itself in the singular', () => {
  const one = payload({
    children: [maya],
    items: [item({ title: 'Swim class', startsAt: '2026-07-21T16:30', needs: 'calendar_add' })],
  });

  it('says "1 needs your OK" on the email and the push, never "1 need"', () => {
    expect(email(one, 'first_name').html).toContain('1 needs your OK');
    expect(email(one, 'first_name').text).toContain('1 needs your OK');
    expect(push(one, 'first_name').body).toContain('1 needs your OK');
  });

  it('keeps the plural for more than one', () => {
    expect(email(fullWeek, 'first_name').html).toContain('4 need your OK');
    expect(push(fullWeek, 'first_name').body).toContain('4 need your OK');
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
