import { describe, expect, it } from 'vitest';
import {
  GROUP_BOTH_FREE,
  GROUP_CALENDAR_ASK,
  GROUP_CALENDAR_RECEIPT,
  GROUP_CONFLICT,
  GROUP_GMAIL_ASK,
  GROUP_GMAIL_RECEIPT,
  GROUP_HANDOFF,
  GROUP_KID_EVENT,
  GROUP_WELCOME,
  groupPostEventText,
} from './group-coparent-copy';
import {
  type BusyBlock,
  classifyKidCalendarItem,
  formatDay,
  formatTime,
  kidMailboxSubject,
  planHouseholdNotices,
  proposeSharedFree,
  splitKidEvent,
} from './household-calendar';

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

describe('group ask strings', () => {
  it('matches the locked in-group asks, and drops the private-link line', () => {
    expect(GROUP_CALENDAR_ASK.en).toBe(
      "{name}, want your calendar in the kids' year too? This link is just for you.",
    );
    expect(GROUP_CALENDAR_ASK.fr).toBe(
      "{name}, tu veux ajouter ton calendrier a l'annee des enfants? Ce lien est juste pour toi.",
    );
    expect(GROUP_GMAIL_ASK.en).toBe(
      '{name}, want me to catch school and camp emails for you too? This link is just for you. Nothing from your inbox shows up here.',
    );
    expect(GROUP_GMAIL_ASK.fr).toBe(
      "{name}, tu veux que je repere aussi les courriels de l'ecole et des camps? Ce lien est juste pour toi. Rien de ta boite ne s'affiche ici.",
    );
    for (const line of [
      GROUP_CALENDAR_ASK.en,
      GROUP_CALENDAR_ASK.fr,
      GROUP_GMAIL_ASK.en,
      GROUP_GMAIL_ASK.fr,
    ]) {
      expect(line).not.toMatch(/one-to-one|en prive/i);
    }
  });
});

describe('design-locked group strings', () => {
  it('matches Sloane byte for byte', () => {
    expect(GROUP_WELCOME.en).toBe(
      "Hi, I'm Hale. This thread is your kids' year — both of you, and me. What should I call you?",
    );
    expect(GROUP_WELCOME.fr).toBe(
      "Salut, c'est Hale. Ce fil, c'est l'annee des enfants: vous deux, et moi. Comment je t'appelle?",
    );
    expect(GROUP_CALENDAR_RECEIPT.en).toBe(
      "{name}'s calendar is connected. I'll keep the kids' stuff straight across both.",
    );
    expect(GROUP_CALENDAR_RECEIPT.fr).toBe(
      'Le calendrier de {name} est connecte. Je suis les activites des enfants sur les deux.',
    );
    expect(GROUP_GMAIL_RECEIPT.en).toBe(
      "{name}'s Gmail is connected. I'll pull out the kids' dates; the inbox stays private.",
    );
    expect(GROUP_GMAIL_RECEIPT.fr).toBe(
      'Le Gmail de {name} est connecte. Je garde les dates des enfants; la boite reste privee.',
    );
    expect(GROUP_KID_EVENT.en).toBe("Heads up: {name} added {kid}'s {event}, {day} at {time}.");
    expect(GROUP_KID_EVENT.fr).toBe(
      'Pour info: {name} a ajoute {event} pour {kid}, {day} a {time}.',
    );
    expect(GROUP_CONFLICT.en).toBe(
      "{kid}'s {event} is {day} at {time}, and you're both busy then. Who's taking it?",
    );
    expect(GROUP_CONFLICT.fr).toBe(
      "{event} pour {kid}, {day} a {time}, et vous etes pris tous les deux. Qui s'en occupe?",
    );
    expect(GROUP_HANDOFF.en).toBe("Tomorrow: {name} has {kid}'s {event} at {time}.");
    expect(GROUP_HANDOFF.fr).toBe("Demain: {name} s'occupe de {event} pour {kid} a {time}.");
    expect(GROUP_BOTH_FREE.en).toBe(
      "You're both free {slot1} or {slot2}. Want the sign-up page for one?",
    );
    expect(GROUP_BOTH_FREE.fr).toBe(
      "Vous etes libres tous les deux {slot1} ou {slot2}. Vous voulez la page d'inscription pour l'un des deux?",
    );
    expect(groupPostEventText('en', 'Sam', 'swim')).toBe(
      'Sam, How did swim go? One line is plenty.',
    );
    expect(groupPostEventText('fr', 'Sam', 'natation')).toBe(
      "Sam, Comment ca s'est passe pour natation ? Une ligne suffit.",
    );
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
    expect(planned[0]?.text).toBe(
      `Heads up: Barton added Maya's gymnastics, ${clock.day} at ${clock.time}.`,
    );
    expect(planned[0]?.text).not.toMatch(/I(?:'ll| will) book/i);
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
    expect(planned[0]?.text).toBe(
      `Maya's gymnastics is ${clock.day} at ${clock.time}, and you're both busy then. Who's taking it?`,
    );
    expect(planned[0]?.text).not.toContain('Quarterly');
    expect(planned[0]?.text).not.toContain('budget');
    expect(planned[0]?.text).not.toContain('free');
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
    expect(planned[0]?.text).toBe(
      `Tomorrow: Barton has Maya's gymnastics at ${formatTime(start, ZONE, 'en')}.`,
    );
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
    expect(planned[0]?.text).toBe(
      `Tomorrow: Sam has Maya's gymnastics at ${formatTime(start, ZONE, 'en')}.`,
    );
  });

  it('asks the parent who took the kid, once, with the locked how-it-went line', () => {
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
    expect(planned[0]?.text).toBe('Barton, How did gymnastics go? One line is plenty.');
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
    expect(planned[0]?.text.split('\n')).toHaveLength(3);
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
    expect(asked).toMatch(/^You're both free .+ or .+\. Want the sign-up page for one\?$/);
    expect(splitKidEvent('swim class', ['Maya', 'Leo'])).toBeNull();
  });
});
