import { describe, expect, it } from 'vitest';
import { judgeSpokenLine } from '~/lib/channel/voice/spoken-line';
import {
  absorbHowItWentLines,
  groupAddressedLine,
  groupBothReaderFrench,
} from './group-coparent-copy';
import { type GroupLineRequest, groupLineInput } from './group-voice';
import {
  type BusyBlock,
  classifyKidCalendarItem,
  formatDay,
  formatTime,
  kidMailboxSubject,
  listSharedFreeSlots,
  planAmbiguousWhoTakes,
  planHouseholdNotices,
  proposeSharedFree,
  splitKidEvent,
} from './household-calendar';
import { whoTakesFactKey } from './logistics-poll';

/**
 * Kid vs not-kid is a function, not a prompt. A non-kid title must be unable
 * to appear in a group notice even when the block still carries one.
 */

const PARENT_A = 'parent-a';
const PARENT_B = 'parent-b';
const NOW = new Date('2026-09-24T18:00:00.000Z');
const ZONE = 'America/Toronto';

function block(over: Partial<BusyBlock> & Pick<BusyBlock, 'eventId' | 'userId'>): BusyBlock {
  return {
    integrationId: `int-${over.userId}`,
    start: new Date('2026-09-25T19:00:00.000Z'),
    end: new Date('2026-09-25T20:00:00.000Z'),
    allDay: false,
    kidRelated: false,
    title: null,
    status: 'confirmed',
    announced: false,
    followupSent: false,
    recurringEventId: null,
    ...over,
  };
}

function notices(blocks: BusyBlock[], now = NOW) {
  return planHouseholdNotices({
    blocks,
    parentUserIds: [PARENT_A, PARENT_B],
    parentNames: { [PARENT_A]: 'Barton', [PARENT_B]: 'Sam' },
    childNames: ['Maya'],
    now,
    timeZone: ZONE,
    language: 'en',
  });
}

function when(date: Date): { day: string; time: string } {
  return { day: formatDay(date, ZONE, 'en'), time: formatTime(date, ZONE, 'en') };
}

describe('classifyKidCalendarItem', () => {
  it('shares a class, a child name, and a gymnastics session', () => {
    expect(classifyKidCalendarItem({ title: 'Maya gymnastics', childNames: ['Maya'] })).toBe(true);
    expect(classifyKidCalendarItem({ title: 'swim class', childNames: [] })).toBe(true);
    expect(classifyKidCalendarItem({ title: 'school pickup', childNames: [] })).toBe(true);
  });

  it('does not treat a parent meeting or the word classic as a class', () => {
    expect(
      classifyKidCalendarItem({ title: 'Quarterly budget review', childNames: ['Maya'] }),
    ).toBe(false);
    expect(classifyKidCalendarItem({ title: 'classic rock night', childNames: [] })).toBe(false);
    expect(classifyKidCalendarItem({ title: '', childNames: ['Maya'] })).toBe(false);
  });
});

describe('kidMailboxSubject', () => {
  it('returns nothing from a subject, a sender, or a body', () => {
    expect(
      kidMailboxSubject({
        subject: 'Gymnastics registration',
        from: 'coach@gym.test',
        body: 'Maya is registered for Tuesday at 4.',
        childNames: ['Maya'],
      }),
    ).toBeNull();
    expect(kidMailboxSubject({ subject: 'Maya <maya@school.test>', childNames: ['Maya'] })).toBe(
      null,
    );
    expect(kidMailboxSubject({ subject: 'Quarterly budget review', childNames: ['Maya'] })).toBe(
      null,
    );
  });
});

describe('group asks hand the model the parent and a link to follow', () => {
  it('names the parent, asks one question, and lets the model say "this link"', () => {
    for (const language of ['en', 'fr'] as const) {
      const ask = groupLineInput({ kind: 'calendar_ask', name: 'Sam' }, language);
      expect(ask.address).toBe('vous');
      expect(ask.questions).toBe(1);
      expect(ask.linkFollows).toBeUndefined();
      expect(ask.mustMention).toEqual(['Sam']);
      expect(ask.facts).toEqual({ name: 'Sam' });
      const gmail = groupLineInput({ kind: 'gmail_ask', name: 'Sam' }, language);
      expect(gmail.questions).toBe(1);
      expect(gmail.linkFollows).toBe(true);
      const link = groupLineInput({ kind: 'calendar_link', name: 'Sam' }, language);
      expect(link.questions).toBe(0);
      expect(link.linkFollows).toBe(true);
      expect(link.mustMention).toEqual(['Sam']);
    }
    // The receipts ask nothing and may not claim a booking.
    const receipt = groupLineInput({ kind: 'gmail_receipt', name: 'Sam' }, 'en');
    expect(receipt.questions).toBe(0);
    expect(receipt.linkFollows).toBeUndefined();
    expect(
      judgeSpokenLine("Sam's Gmail is connected. I've booked the kids' dates for you.", receipt),
    ).toEqual({ ok: false, reason: 'forbidden:booking_claim' });
    expect(
      judgeSpokenLine(
        "Sam's Gmail is connected. I'll pull the kids' dates out of it; the inbox itself stays private.",
        receipt,
      ),
    ).toEqual({ ok: true });
  });
});

describe('two-reader group lines', () => {
  it('names a known parent on how-it-went and empty Saturday, and nobody when unknown', () => {
    const known = groupLineInput({ kind: 'how_it_went', name: 'Sam', activity: 'swim' }, 'en');
    expect(known.facts).toEqual({ name: 'Sam', activity: 'swim' });
    expect(known.mustMention).toEqual(['swim', 'Sam']);
    expect(known.questions).toBe(1);

    const unknown = groupLineInput({ kind: 'how_it_went', name: null, activity: 'swim' }, 'fr');
    expect(unknown.mustMention).toEqual(['swim']);
    expect(unknown.address).toBe('vous');
    // Two readers: the French may not slip into tu.
    expect(judgeSpokenLine("Comment s'est passée la natation pour toi, swim ?", unknown)).toEqual({
      ok: false,
      reason: 'french',
    });
    expect(judgeSpokenLine("Alors, comment ça s'est passé, swim ?", unknown)).toEqual({ ok: true });

    const saturday = groupLineInput({ kind: 'empty_saturday', name: 'Sam', kid: 'Maya' }, 'en');
    expect(saturday.facts).toEqual({ name: 'Sam', kid: 'Maya', day: 'Saturday' });
    expect(saturday.mustMention).toEqual(['Maya', 'Sam', 'Saturday']);
    // Saturday is the only weekday it may name, because that is the fact.
    expect(
      judgeSpokenLine('Sam, Saturday looks open for Maya. Want one nearby idea?', saturday),
    ).toEqual({ ok: true });
    expect(
      judgeSpokenLine('Sam, Sunday looks open for Maya. Want one nearby idea?', saturday),
    ).toEqual({ ok: false, reason: 'invented' });
  });

  it('prefixes a known evening and leaves an unknown one alone', () => {
    expect(
      groupAddressedLine('Sam', 'How did today go with Mia and Leo? One line is plenty.'),
    ).toBe('Sam, how did today go with Mia and Leo? One line is plenty.');
    expect(groupAddressedLine('Sam', 'What was the best bit of today with Mia?')).toBe(
      'Sam, what was the best bit of today with Mia?',
    );
  });

  it('names the parent who left when stored, and hands the model no name otherwise', () => {
    const named = groupLineInput({ kind: 'departure', name: 'Sam' }, 'en');
    expect(named.mustMention).toEqual(['Sam']);
    expect(named.questions).toBe(0);
    expect(named.address).toBe('vous');

    const unnamed = groupLineInput({ kind: 'departure', name: null, address: 'tu' }, 'fr');
    expect(unnamed.facts).toEqual({ name: null, remaining: null });
    expect(unnamed.mustMention).toEqual([]);
    expect(unnamed.address).toBe('tu');
    // A departure states; it does not ask.
    expect(judgeSpokenLine('Ton co-parent a quitté Hale. Ça va ?', unnamed)).toEqual({
      ok: false,
      reason: 'question',
    });
  });

  it('switches a both-parents French line to vous and keeps English', () => {
    expect(groupBothReaderFrench('Tu veux une idee? Envoie-moi un oui.')).toBe(
      'Vous voulez une idee? Envoyez-moi un oui.',
    );
    expect(groupBothReaderFrench('Regarde ton calendrier et ta liste.')).toBe(
      'Regarde votre calendrier et votre liste.',
    );
    expect(groupBothReaderFrench('Want one nearby find?')).toBe('Want one nearby find?');
  });

  it('folds up to three how-it-went lines into the weekly bubble', () => {
    const weekly = 'This week: swim on Tuesday.';
    const lines = [
      'Sam, how did swim go? One line is plenty.',
      'Sam, how did art go? One line is plenty.',
      'Sam, how did music go? One line is plenty.',
      'Sam, how did dance go? One line is plenty.',
    ];
    const body = absorbHowItWentLines(weekly, lines);
    expect(body).toContain(weekly);
    expect(body).toContain('swim');
    expect(body).toContain('music');
    expect(body).not.toContain('dance');
    expect(body.split('\n')).toHaveLength(4);
  });
});

describe('group lines are written from facts, inside the red lines', () => {
  const kidEvent: GroupLineRequest = {
    kind: 'kid_event',
    events: [{ parent: 'Barton', kid: 'Maya', event: 'gymnastics', day: 'Fri', time: '15:00' }],
  };

  it('a kid event must carry the kid, the event, and the time, and may not invent another', () => {
    const input = groupLineInput(kidEvent, 'en');
    expect(input.questions).toBe(0);
    expect(input.mustMention).toEqual(['Maya', 'gymnastics', '15:00']);
    expect(
      judgeSpokenLine(
        "Heads up, Barton put Maya's gymnastics on the calendar: Fri at 15:00.",
        input,
      ),
    ).toEqual({ ok: true });
    expect(
      judgeSpokenLine("Barton added Maya's gymnastics, Fri at 15:00. Pickup is at 16:30.", input),
    ).toEqual({ ok: false, reason: 'invented' });
    expect(
      judgeSpokenLine("Barton added Maya's gymnastics, Fri at 15:00. I've booked it.", input),
    ).toEqual({ ok: false, reason: 'forbidden:booking_claim' });
    expect(
      judgeSpokenLine("Barton added Maya's gymnastics, Fri at 15:00. Who's driving?", input),
    ).toEqual({ ok: false, reason: 'question' });
  });

  it('a conflict asks exactly one question and never names the other calendar', () => {
    const input = groupLineInput(
      { kind: 'conflict', kid: 'Maya', event: 'gymnastics', day: 'Fri', time: '15:00' },
      'en',
    );
    expect(input.questions).toBe(1);
    expect(input.facts).not.toHaveProperty('other');
    expect(
      judgeSpokenLine(
        "Maya's gymnastics is Fri at 15:00 and you both have something on. Who's taking it?",
        input,
      ),
    ).toEqual({ ok: true });
    expect(
      judgeSpokenLine(
        "Maya's gymnastics is Fri at 15:00. You're both busy. Who takes it? Or skip?",
        input,
      ),
    ).toEqual({ ok: false, reason: 'question' });
  });

  it('a handoff states tomorrow and names the parent; a sync never says Hale booked', () => {
    const handoff = groupLineInput(
      { kind: 'handoff', name: 'Sam', kid: 'Maya', event: 'gymnastics', time: '15:00' },
      'fr',
    );
    expect(handoff.facts).toMatchObject({ when: 'demain' });
    expect(judgeSpokenLine('Demain, Sam emmène Maya à gymnastics à 15:00.', handoff)).toEqual({
      ok: true,
    });
    expect(judgeSpokenLine('Demain, tu emmènes Maya à gymnastics à 15:00, Sam.', handoff)).toEqual({
      ok: false,
      reason: 'french',
    });

    const sync = groupLineInput(
      {
        kind: 'decision_sync',
        decisions: [
          {
            parent: 'Sam',
            decision: 'picked',
            activity: 'swim',
            kid: 'Maya',
            day: 'Sat',
            time: '9:00',
          },
        ],
      },
      'en',
    );
    expect(judgeSpokenLine('Quick sync: Sam picked swim for Maya, Sat at 9:00.', sync)).toEqual({
      ok: true,
    });
    expect(
      judgeSpokenLine(
        "Quick sync: Sam picked swim for Maya, Sat at 9:00. I've registered her.",
        sync,
      ),
    ).toEqual({ ok: false, reason: 'forbidden:booking_claim' });
  });

  it('both-free names both slots and asks once; the welcome asks the one name question', () => {
    const bothFree = groupLineInput({ kind: 'both_free', slots: ['Sat 10:00', 'Sun 14:00'] }, 'en');
    expect(bothFree.mustMention).toEqual(['Sat 10:00', 'Sun 14:00']);
    expect(
      judgeSpokenLine(
        "You're both free Sat 10:00 or Sun 14:00. Want the sign-up page for one?",
        bothFree,
      ),
    ).toEqual({ ok: true });

    const welcome = groupLineInput({ kind: 'welcome' }, 'en');
    expect(welcome.facts).toEqual({});
    expect(welcome.questions).toBe(1);
    expect(
      judgeSpokenLine(
        "Hi, I'm Hale. This thread is for both of you. What should I call you?",
        welcome,
      ),
    ).toEqual({ ok: true });
    expect(
      judgeSpokenLine(
        "Hi, I'm Hale. This thread is your kids' year. What should I call you?",
        welcome,
      ),
    ).toEqual({ ok: false, reason: 'forbidden:kids_year' });
    expect(
      judgeSpokenLine("Hi, I'm Hale. Reply STOP anytime. What should I call you?", welcome),
    ).toEqual({ ok: false, reason: 'compliance' });
  });
});

describe('planHouseholdNotices', () => {
  const start = new Date('2026-09-25T19:00:00.000Z');

  it('sends one heads-up and never the private title', () => {
    const planned = notices([
      block({
        eventId: 'gym',
        userId: PARENT_A,
        kidRelated: true,
        title: 'Maya gymnastics',
        start,
        end: new Date('2026-09-25T20:00:00.000Z'),
      }),
    ]);
    const clock = when(start);
    expect(planned).toHaveLength(1);
    expect(planned[0]?.line).toEqual({
      kind: 'kid_event',
      events: [
        { parent: 'Barton', kid: 'Maya', event: 'gymnastics', day: clock.day, time: clock.time },
      ],
    });
    expect(planned[0]?.recipientUserId).toBe(PARENT_B);
  });

  it('says both are busy and does not name the other event', () => {
    const planned = notices([
      block({
        eventId: 'gym',
        userId: PARENT_A,
        kidRelated: true,
        title: 'Maya gymnastics',
        start,
        end: new Date('2026-09-25T20:00:00.000Z'),
      }),
      block({
        eventId: 'budget',
        userId: PARENT_B,
        kidRelated: false,
        title: 'Quarterly budget review',
        start,
        end: new Date('2026-09-25T20:00:00.000Z'),
      }),
    ]);
    const clock = when(start);
    expect(planned).toHaveLength(1);
    expect(planned[0]?.kind).toBe('conflict');
    expect(planned[0]?.line).toEqual({
      kind: 'conflict',
      kid: 'Maya',
      event: 'gymnastics',
      day: clock.day,
      time: clock.time,
    });
    // The other calendar's title never reaches the model, so it cannot reach the group.
    const handed = JSON.stringify(planned[0]?.line);
    expect(handed).not.toContain('Quarterly');
    expect(handed).not.toContain('budget');
    const passed = planHouseholdNotices({
      blocks: [
        block({
          eventId: 'gym',
          userId: PARENT_A,
          kidRelated: true,
          title: 'Maya gymnastics',
          start,
          end: new Date('2026-09-25T20:00:00.000Z'),
        }),
        block({
          eventId: 'budget',
          userId: PARENT_B,
          kidRelated: false,
          title: 'Quarterly budget review',
          start,
          end: new Date('2026-09-25T20:00:00.000Z'),
        }),
      ],
      parentUserIds: [PARENT_A, PARENT_B],
      parentNames: { [PARENT_A]: 'Barton', [PARENT_B]: 'Sam' },
      childNames: ['Maya'],
      now: NOW,
      timeZone: ZONE,
      language: 'en',
      statements: [{ userId: PARENT_A, text: "We'll figure it out", at: NOW }],
    });
    expect(passed.find((notice) => notice.kind === 'conflict')).toBeUndefined();
  });

  it('does not treat two calendars a week apart as a handoff', () => {
    const evening = new Date('2026-09-24T22:00:00.000Z');
    const planned = notices(
      [
        block({
          eventId: 'this-week',
          userId: PARENT_A,
          kidRelated: true,
          title: 'Maya gymnastics',
          announced: true,
          start: new Date('2026-09-26T19:00:00.000Z'),
          end: new Date('2026-09-26T20:00:00.000Z'),
        }),
        block({
          eventId: 'next-week',
          userId: PARENT_B,
          kidRelated: true,
          title: 'Maya gymnastics',
          announced: true,
          start: new Date('2026-10-02T19:00:00.000Z'),
          end: new Date('2026-10-02T20:00:00.000Z'),
        }),
      ],
      evening,
    );
    expect(planned.find((notice) => notice.kind === 'handoff')).toBeUndefined();
  });

  it('states a handoff the evening before when the event is on one calendar', () => {
    const evening = new Date('2026-09-24T22:00:00.000Z');
    const planned = notices(
      [
        block({
          eventId: 'tomorrow',
          userId: PARENT_A,
          kidRelated: true,
          title: 'Maya gymnastics',
          start,
          end: new Date('2026-09-25T20:00:00.000Z'),
        }),
      ],
      evening,
    );
    expect(planned).toHaveLength(1);
    expect(planned[0]?.line).toEqual({
      kind: 'handoff',
      name: 'Barton',
      kid: 'Maya',
      event: 'gymnastics',
      time: formatTime(start, ZONE, 'en'),
    });
  });

  it("uses a parent's own words for a handoff when both calendars show the event", () => {
    const evening = new Date('2026-09-24T22:00:00.000Z');
    const planned = planHouseholdNotices({
      blocks: [
        block({
          eventId: 'a',
          userId: PARENT_A,
          kidRelated: true,
          title: 'Maya gymnastics',
          start,
          end: new Date('2026-09-25T20:00:00.000Z'),
        }),
        block({
          eventId: 'b',
          userId: PARENT_B,
          kidRelated: true,
          title: 'Maya gymnastics',
          start,
          end: new Date('2026-09-25T20:00:00.000Z'),
        }),
      ],
      parentUserIds: [PARENT_A, PARENT_B],
      parentNames: { [PARENT_A]: 'Barton', [PARENT_B]: 'Sam' },
      childNames: ['Maya'],
      now: evening,
      timeZone: ZONE,
      language: 'en',
      statements: [{ userId: PARENT_B, text: "I'll take Maya gymnastics" }],
    });
    expect(planned).toHaveLength(1);
    expect(planned[0]?.kind).toBe('handoff');
    expect(planned[0]?.line).toEqual({
      kind: 'handoff',
      name: 'Sam',
      kid: 'Maya',
      event: 'gymnastics',
      time: formatTime(start, ZONE, 'en'),
    });
  });

  it('asks the parent who took the kid, once, with a how-it-went line', () => {
    const planned = notices([
      block({
        eventId: 'done-1',
        userId: PARENT_A,
        kidRelated: true,
        title: 'Maya gymnastics',
        announced: true,
        start: new Date('2026-09-24T15:00:00.000Z'),
        end: new Date('2026-09-24T16:00:00.000Z'),
      }),
    ]);
    expect(planned).toHaveLength(1);
    expect(planned[0]?.kind).toBe('followup');
    expect(planned[0]?.line).toEqual({
      kind: 'how_it_went',
      name: 'Barton',
      activity: 'gymnastics',
    });
    expect(planned[0]?.recipientUserId).toBe(PARENT_A);
  });

  it('suppresses a follow-up when both calendars hold the event and nobody said who took it', () => {
    const planned = notices([
      block({
        eventId: 'done-a',
        userId: PARENT_A,
        kidRelated: true,
        title: 'Maya gymnastics',
        announced: true,
        start: new Date('2026-09-24T15:00:00.000Z'),
        end: new Date('2026-09-24T16:00:00.000Z'),
      }),
      block({
        eventId: 'done-b',
        userId: PARENT_B,
        kidRelated: true,
        title: 'Maya gymnastics',
        announced: true,
        start: new Date('2026-09-24T15:00:00.000Z'),
        end: new Date('2026-09-24T16:00:00.000Z'),
      }),
    ]);
    expect(planned.filter((notice) => notice.kind === 'followup')).toHaveLength(0);
  });

  it('folds several new kid events into one bubble of at most three lines', () => {
    const planned = notices(
      ['one', 'two', 'three', 'four'].map((eventId, index) =>
        block({
          eventId,
          userId: PARENT_A,
          kidRelated: true,
          title: 'Maya gymnastics',
          start: new Date(start.getTime() + index * 24 * 60 * 60 * 1000),
          end: new Date(start.getTime() + index * 24 * 60 * 60 * 1000 + 60 * 60 * 1000),
        }),
      ),
    );
    expect(planned).toHaveLength(1);
    const line = planned[0]?.line;
    expect(line?.kind).toBe('kid_event');
    expect(line?.kind === 'kid_event' ? line.events : []).toHaveLength(3);
    expect(planned[0]?.mark).toHaveLength(3);
  });

  it('does not offer a shared free window unless someone asked', () => {
    expect(
      proposeSharedFree({
        requested: false,
        blocks: [],
        now: NOW,
        timeZone: ZONE,
        language: 'en',
      }),
    ).toBeNull();
    const asked = proposeSharedFree({
      requested: true,
      blocks: [],
      now: NOW,
      timeZone: ZONE,
      language: 'en',
    });
    // Two real slots, formatted once, for the model to name both of.
    expect(asked).toHaveLength(2);
    expect(asked?.[0]).not.toBe(asked?.[1]);
    expect(
      groupLineInput({ kind: 'both_free', slots: asked as [string, string] }, 'en').mustMention,
    ).toEqual(asked);
    expect(splitKidEvent('swim class', ['Maya', 'Leo'])).toBeNull();
    const oneHour = listSharedFreeSlots({
      requested: true,
      blocks: [
        block({
          eventId: 'fill',
          userId: PARENT_A,
          start: new Date('2026-09-24T19:00:00.000Z'),
          end: new Date('2026-09-30T23:00:00.000Z'),
        }),
      ],
      now: NOW,
      timeZone: ZONE,
      language: 'en',
    });
    expect(oneHour.length).toBeLessThan(2);
  });

  it('reads a stored taker at the evening handoff and does not invent one', () => {
    const evening = new Date('2026-09-24T22:00:00.000Z');
    const both = [
      block({
        eventId: 'a',
        userId: PARENT_A,
        kidRelated: true,
        title: 'Maya gymnastics',
        announced: true,
        start,
        end: new Date('2026-09-25T20:00:00.000Z'),
      }),
      block({
        eventId: 'b',
        userId: PARENT_B,
        kidRelated: true,
        title: 'Maya gymnastics',
        announced: true,
        start,
        end: new Date('2026-09-25T20:00:00.000Z'),
      }),
    ];
    const key = whoTakesFactKey(start.toISOString(), 'maya gymnastics');
    const remembered = {
      factKey: key,
      kind: 'who_takes' as const,
      startIso: start.toISOString(),
      titleNorm: 'maya gymnastics',
      slotLabel: null,
      slotStart: null,
      kid: 'Maya',
      event: 'gymnastics',
      day: null,
      slots: [],
    };
    const decided = planHouseholdNotices({
      blocks: both,
      parentUserIds: [PARENT_A, PARENT_B],
      parentNames: { [PARENT_A]: 'Barton', [PARENT_B]: 'Sam' },
      childNames: ['Maya'],
      now: evening,
      timeZone: ZONE,
      language: 'en',
      remembered: [{ ...remembered, status: 'decided', takerUserId: PARENT_B }],
    });
    expect(decided[0]?.kind).toBe('handoff');
    expect(decided[0]?.line).toEqual({
      kind: 'handoff',
      name: 'Sam',
      kid: 'Maya',
      event: 'gymnastics',
      time: formatTime(start, ZONE, 'en'),
    });
    const unanswered = planHouseholdNotices({
      blocks: both,
      parentUserIds: [PARENT_A, PARENT_B],
      parentNames: { [PARENT_A]: 'Barton', [PARENT_B]: 'Sam' },
      childNames: ['Maya'],
      now: evening,
      timeZone: ZONE,
      language: 'en',
      remembered: [{ ...remembered, status: 'open', takerUserId: null }],
    });
    expect(unanswered.find((notice) => notice.kind === 'handoff')).toBeUndefined();
    expect(unanswered.find((notice) => notice.line.kind === 'handoff')).toBeUndefined();
    const declined = planHouseholdNotices({
      blocks: both,
      parentUserIds: [PARENT_A, PARENT_B],
      parentNames: { [PARENT_A]: 'Barton', [PARENT_B]: 'Sam' },
      childNames: ['Maya'],
      now: evening,
      timeZone: ZONE,
      language: 'en',
      remembered: [{ ...remembered, status: 'declined', takerUserId: null }],
    });
    expect(declined.find((notice) => notice.kind === 'handoff')).toBeUndefined();
    expect(declined.find((notice) => notice.kind === 'conflict')).toBeUndefined();
  });
});

describe('planAmbiguousWhoTakes', () => {
  it('asks who takes a tomorrow event when nobody is the taker and nobody else is busy', () => {
    const evening = new Date('2026-09-24T22:00:00.000Z');
    const start = new Date('2026-09-25T19:00:00.000Z');
    const ask = planAmbiguousWhoTakes({
      blocks: [
        block({
          eventId: 'gym',
          userId: PARENT_A,
          kidRelated: true,
          title: 'Maya gymnastics',
          start,
          end: start,
        }),
      ],
      parentUserIds: [PARENT_A, PARENT_B],
      parentNames: { [PARENT_A]: 'Barton', [PARENT_B]: 'Sam' },
      childNames: ['Maya'],
      now: evening,
      timeZone: ZONE,
      language: 'en',
    });
    expect(ask?.kind).toBe('who_takes');
    const clock = when(start);
    // The ask is the who-takes line, not the conflict line: nobody is said to be busy.
    expect(ask?.line).toEqual({
      kind: 'who_takes',
      kid: 'Maya',
      event: 'gymnastics',
      day: clock.day,
      time: clock.time,
    });
  });
});
