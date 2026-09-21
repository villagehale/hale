import type { WeekPlanItem } from '@hale/db';
import { describe, expect, it } from 'vitest';
import type { LoopMessage, RenderedContent } from '~/lib/channel/types';
import { isGsm7, smsSegments } from '~/lib/channel/sms-segments';
import type { ChildNameLevel } from '~/lib/loop/prefs';
import { weeklyPlanRenderer } from './index';
import { bareYesNoQuestions } from '~/lib/testing/pool-copy';
import type { PlanChild, WeeklyPlanPayload } from './payload';
import { foldWeeklyVoice } from './sms';

/** The three ways a fully-placed week can close. Restated here rather than imported:
 * these words are the spec, and a copy change should be a diff read in two places. */
const PLACED_LINES = [
  'All on your calendar.',
  'Nothing needs you this week.',
  "That's the whole week, already placed.",
] as const;

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
  channel: 'email' | 'sms',
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

/** The composed-voice outcome the renderer reports for this render — `undefined` where
 * the message has no voice slot at all, which is a different fact from 'absent'. */
function smsVoice(p: WeeklyPlanPayload, level: ChildNameLevel): unknown {
  const r = render(p, 'sms', level);
  if (r.kind !== 'sms') throw new Error('expected sms');
  return r.voice;
}

function email(p: WeeklyPlanPayload, level: ChildNameLevel) {
  const r = render(p, 'email', level);
  if (r.kind !== 'email') throw new Error('expected email');
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

  it('opens with the possessive header and the reply invitation, and no broadcast prefix', () => {
    const text = sms(fullWeek, 'first_name');
    // `Hale: ` is gone (docs/voice.md rule 2): it is a broadcast header on a thread the
    // parent already knows is Hale's. The possessive header is what opens the message now.
    expect(text.startsWith("Maya & Liam's week")).toBe(true);
    expect(text).not.toContain('Hale:');
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
    // Re-pinned as the fact stated positively: the placed line is now a three-member pool,
    // so "does not contain this one literal" would pass on two thirds of the weeks it is
    // meant to catch. What is true is that a week with something pending and nothing
    // approvable ENDS WITH THE WEEK — no closing line at all.
    for (const placed of PLACED_LINES) expect(text, placed).not.toContain(placed);
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

  it('SMS asks exactly one question, names no event, and teaches no dead keyword', () => {
    const text = sms(quiet, 'generic');
    expect(text).toContain('Your week');
    expect(smsSegments(text)).toBe(1);
    // Re-pinned from `toContain('A quiet week')`: the quiet ask is a three-member pool, so
    // the invariant is the SHAPE — one question, nothing on the calendar named, and a
    // question a bare YES cannot answer, because the approvals resolver claims a family-
    // wide YES and this week has nothing drafted for it to resolve.
    expect((text.match(/\?/g) ?? []).length).toBe(1);
    expect(bareYesNoQuestions(text)).toEqual([]);
    expect(text).not.toMatch(/Mon|Tue|Wed|Thu|Fri|Sat:|Sun/);
    // `Reply IDEAS` is GONE: there is no handler for IDEAS anywhere in lib/channel, so it
    // was vocabulary Hale taught and could not honour (rule 10).
    expect(text).not.toContain('IDEAS');
  });

  it('SMS rotates the quiet ask week to week, and never repeats two weeks running', () => {
    const weeks = ['2026-07-13', '2026-07-20', '2026-07-27', '2026-08-03'].map(
      (weekStart) => sms(payload({ children: [], items: [], weekStart }), 'generic'),
    );
    for (let i = 1; i < weeks.length; i++) {
      expect(weeks[i], `week ${i}`).not.toBe(weeks[i - 1]);
    }
  });

  it('SMS uses the composed week framing when it clears the same bar the pool does', () => {
    const framed = payload({
      children: [],
      items: [],
      weekStart: '2026-07-20',
      voice: {
        greeting: 'Hi',
        weekFraming: 'Nothing booked yet - what would make this one feel easier?',
        itemLines: {},
        signOff: 'See you Sunday',
      },
    });
    const text = sms(framed, 'generic');
    expect(text).toContain('what would make this one feel easier?');
    expect(smsSegments(text)).toBe(1);
    // THE OUTCOME LEAVES THE RENDERER (rule #11): the caller is told which half of the
    // slot the parent read, rather than having to substring-match a sentence it did not
    // choose out of a body it did not compose.
    expect(smsVoice(framed, 'generic')).toBe('used');
    expect(
      foldWeeklyVoice('Nothing booked yet - what would make this one feel easier?', 1).outcome,
    ).toBe('used');
    // And refuses one that breaks the slot's own question rule, rather than shipping a
    // model sentence that asks twice on a surface where a bare YES is already claimed.
    // EACH REFUSAL BY ITS OWN NAME: a question is the model's register, a dropped
    // character is its charset, and they are fixed in different places.
    expect(foldWeeklyVoice('Two questions? Really two?', 1).outcome).toBe(
      'refused:question_count',
    );
    expect(foldWeeklyVoice('A statement with no question.', 1).outcome).toBe(
      'refused:question_count',
    );
    expect(foldWeeklyVoice(null, 1).outcome).toBe('absent');
    // A character GSM-7 cannot carry is refused too — gsmSafe would silently fold it, and
    // a silent fold is a sentence nobody reviewed.
    expect(foldWeeklyVoice('A quiet week — what would suit Saturday?', 1).outcome).toBe(
      'refused:gsm_dropped',
    );
  });

  it('reports the refusal the WEEK made, not the one the fold did', () => {
    // A framing the fold passed and the whole message then refused is an over-segment
    // refusal, and it is the one the fold itself can never return: a sentence's cost
    // depends on the week it rides with, so only the renderer can measure it. Reported as
    // itself, because "the model wrote a question" and "the model wrote a page" are
    // different things to go and look at.
    const long = `A quiet week and nothing on it yet, ${'which leaves the whole of it open for whatever you feel like doing, '.repeat(6)}so what would make Saturday good?`;
    const p = payload({
      children: [],
      items: [],
      weekStart: '2026-07-20',
      voice: { greeting: 'Hi', weekFraming: long, itemLines: {}, signOff: 'See you Sunday' },
    });
    const text = sms(p, 'generic');
    // The fold itself passes it — one question, nothing dropped — and the week refuses it.
    expect(foldWeeklyVoice(long, 1).outcome).toBe('used');
    expect(text).not.toContain(long);
    expect(smsSegments(text)).toBeLessThanOrEqual(3);
    expect(smsVoice(p, 'generic')).toBe('refused:over_segment');
    // The pool is the floor under the fold, not its replacement.
    expect((text.match(/\?/g) ?? []).length).toBe(1);
  });

  it('says the composer degraded when there is no voice at all', () => {
    expect(smsVoice(payload({ children: [], items: [], weekStart: '2026-07-20' }), 'generic')).toBe(
      'absent',
    );
  });

  it('email subject is "Your week ahead" and carries the reply invitation', () => {
    const e = email(quiet, 'generic');
    expect(e.subject).toBe('Your week ahead');
    expect(e.html.toLowerCase()).toContain('reply to this email to adjust');
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

  it('SMS closes with one of the placed lines and contains ZERO questions', () => {
    const text = sms(placed, 'first_name');
    // Re-pinned from the single literal: the week that asks nothing is a three-member
    // pool, and the invariant is that it asks NOTHING — zero "?", not one.
    expect(text).not.toContain('?');
    expect(PLACED_LINES.some((line) => text.includes(line)), text).toBe(true);
    expect(text).not.toContain('need your OK');
  });

  it('SMS rotates the placed line week to week', () => {
    const weeks = ['2026-07-13', '2026-07-20', '2026-07-27'].map((weekStart) =>
      sms(payload({ ...placed, weekStart }), 'first_name'),
    );
    for (let i = 1; i < weeks.length; i++) {
      expect(weeks[i], `week ${i}`).not.toBe(weeks[i - 1]);
    }
  });

  it('SMS uses the composed sign-off when there is one, and never one that asks', () => {
    const signed = payload({
      ...placed,
      voice: {
        greeting: 'Hi',
        weekFraming: 'A full one',
        itemLines: {},
        signOff: "That's the lot - nothing needs you.",
      },
    });
    const text = sms(signed, 'first_name');
    expect(text).toContain("That's the lot - nothing needs you.");
    expect(text).not.toContain('?');
    expect(smsVoice(signed, 'first_name')).toBe('used');
    expect(foldWeeklyVoice('Anything else you want moved?', 0).outcome).toBe(
      'refused:question_count',
    );
    // The week that asks nothing and was composed nothing: the slot exists and the
    // composer gave it nothing, which is 'absent' and not a refusal.
    expect(smsVoice(placed, 'first_name')).toBe('absent');
  });

  it('reports NOTHING on a week that ends on the approval ask', () => {
    // The sign-off slot only exists on a week with nothing pending. Any other week closes
    // on a count of rows the mint is holding — a fact, never a composed sentence — so
    // there is no outcome to report, and reporting 'absent' there would invent a
    // composer failure on a slot that was never asked for.
    expect(smsVoice(fullWeek, 'first_name')).toBeUndefined();
  });

  /** A fully-placed week with a real week's worth of items on it: it reads inline, with
   * every item, and it is close enough to the three-segment ceiling that a composed
   * closing sentence is the thing that can push it over. */
  const busyPlaced = payload({
    children: [maya, liam],
    items: [
      item({ kind: 'village', title: 'Library storytime', childIds: ['c-maya'], startsAt: '2026-07-20T10:30' }),
      item({ kind: 'village', title: 'Swim class', childIds: ['c-liam'], startsAt: '2026-07-20T16:30' }),
      item({ kind: 'routine', title: 'Music class', childIds: ['c-maya'], startsAt: '2026-07-21T09:00' }),
      item({ kind: 'village', title: 'Soccer practice', childIds: ['c-liam'], startsAt: '2026-07-22T17:00' }),
      item({ kind: 'village', title: 'Park meetup', childIds: ['c-maya'], startsAt: '2026-07-23T14:00' }),
      item({ kind: 'appointment', title: 'Dentist', childIds: ['c-liam'], startsAt: '2026-07-24T11:15' }),
      item({ kind: 'village', title: 'Gymnastics', childIds: ['c-maya'], startsAt: '2026-07-25T15:45' }),
      item({ kind: 'birthday', title: "Liam's birthday", childIds: ['c-liam'], startsAt: '2026-07-26' }),
    ],
  });

  const withSignOff = (p: WeeklyPlanPayload, signOff: string) =>
    payload({ ...p, voice: { greeting: 'Hi', weekFraming: 'A full one', itemLines: {}, signOff } });

  it('refuses a sign-off that would cost the parent their week, and says which happened', () => {
    // THE SIGN-OFF IS NOT ALLOWED TO CHANGE THE SHAPE OF THE MESSAGE. It used to be
    // spliced into the tail BEFORE the inline-vs-linked choice was made, so a long
    // composed sentence pushed the whole message past three segments and the renderer
    // answered by replacing the parent's entire item list with the one app link this
    // product keeps as a narrow exception — and still reported 'used'. A composed
    // sentence may change the WORDS of the closing line and nothing else about the
    // message: the shape is decided from the reviewed pool copy, always.
    const plain = sms(busyPlaced, 'first_name');
    expect(plain).toContain('Swim class');
    expect(plain).not.toContain('Full week:');
    expect(smsSegments(plain)).toBeLessThanOrEqual(3);

    const long = `That is the whole week and every one of them is already on your calendar, ${'so there is nothing at all for you to do about any of it this time round, '.repeat(3)}enjoy it.`;
    const signed = withSignOff(busyPlaced, long);
    // The FOLD passes it — zero questions, nothing dropped — and the WEEK refuses it,
    // which is the one outcome the fold itself can never return.
    expect(foldWeeklyVoice(long, 0).outcome).toBe('used');
    expect(smsVoice(signed, 'first_name')).toBe('refused:over_segment');
    // Byte-identical to the week with no voice at all: the parent loses the sentence and
    // keeps everything else, rather than losing their list to keep the sentence.
    expect(sms(signed, 'first_name')).toBe(plain);
  });

  it('measures the sign-off on the week that was already too long to read inline', () => {
    // The other unmeasured tail: past the item cap the message is the link form by count,
    // and the sign-off rides on it. That is legitimate — the week displaced the list, not
    // the voice — but it is still measured, because a composed page appended to a link is
    // a four-segment text nobody chose.
    const many = payload({
      ...busyPlaced,
      items: [
        ...busyPlaced.items,
        item({ kind: 'village', title: 'Skating', childIds: ['c-maya'], startsAt: '2026-07-26T08:00' }),
      ],
    });
    const linked = sms(many, 'first_name');
    expect(linked).toContain('Full week:');

    const short = withSignOff(many, 'All of it is on your calendar already.');
    expect(sms(short, 'first_name')).toContain('All of it is on your calendar already.');
    expect(smsVoice(short, 'first_name')).toBe('used');

    const page = withSignOff(
      many,
      `Every last one of them is on your calendar already, ${'and none of it needs a thing from you between now and Sunday evening, '.repeat(5)}so enjoy the week.`,
    );
    expect(smsVoice(page, 'first_name')).toBe('refused:over_segment');
    expect(sms(page, 'first_name')).toBe(linked);
    expect(smsSegments(sms(page, 'first_name'))).toBeLessThanOrEqual(3);
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

describe('voice honors the child_name_level dial (privacy — rule #1)', () => {
  // The gap the existing matrix missed: (voice present) × (non-first_name level) × (a
  // baked first name INSIDE a voice string). The composed voice is per-family
  // (pre-parent), so re-leveling must happen at render time.
  const mayaVoiceLeak = payload({
    children: [maya],
    summary: 'a deterministic fallback sentence',
    items: [healthAppt],
    voice: {
      greeting: 'Hi, here is what Maya has coming up',
      weekFraming: "Maya's week is calm, with one checkup to book",
      itemLines: { '0': 'a quick check for Maya, nothing more' },
      signOff: 'reply any time, we are here for you and Maya',
    },
  });

  it('generic re-levels the baked name out of every voice slot', () => {
    const r = email(mayaVoiceLeak, 'generic');
    expect(r.html).not.toContain('Maya');
    // Positive control: the greeting was RE-LEVELED to "your kid" (not merely absent),
    // pairing the negative assertion with a positive one through the same path.
    expect(r.html).toContain('here is what your kid has coming up');
    // The resolution is shared, so the plain-text path is scrubbed too.
    expect(r.text).not.toContain('Maya');
  });

  it('first_name keeps the baked name in the voice (positive control, same path)', () => {
    expect(email(mayaVoiceLeak, 'first_name').html).toContain('Maya');
  });
});

describe('the pending heading agrees with itself in the singular', () => {
  const one = payload({
    children: [maya],
    items: [item({ title: 'Swim class', startsAt: '2026-07-21T16:30', needs: 'calendar_add' })],
  });

  it('says "1 needs your OK" on the email, never "1 need"', () => {
    expect(email(one, 'first_name').html).toContain('1 needs your OK');
    expect(email(one, 'first_name').text).toContain('1 needs your OK');
  });

  it('keeps the plural for more than one', () => {
    expect(email(fullWeek, 'first_name').html).toContain('4 need your OK');
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

});
