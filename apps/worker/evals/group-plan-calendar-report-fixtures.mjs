// The group plan report — the corpus (VIL-443 T17).
//
// Expectations come from the SPEC (packages/agent/skills/group-plan-calendar-report.md)
// and the ticket: what goes into the family group after its plan is placed, moved or
// called off (one message or a few, the model's call), saying when it starts and ends and
// where in full, whose own calendars it reached, who it is not on yet, and handing the
// add-to-calendar link. Its eval cases are here: an edit or cancel reaching every copy
// (moved, cancelled), a family with no calendar connected, and a plan with no end.
// Duplicate invites are structural (one send per revision) and live in the pglite tests,
// not here. No fixed copy and no wording checks: a judge reads facts and tone. en, fr,
// es, zh.

const LINK =
  'https://app.villagehale.com/api/ics/event/5d0e3a52-1b7c-4f0e-9a51-0c3f7b2a9e41.Qm9vZ3lHcm91cA';
const SWIM = {
  title: 'Swim lesson',
  starts: 'Sat, Nov 7, 10:00 a.m.',
  ends: '11:00 a.m.',
  where: 'Riverside Y, 120 Main St, Toronto',
};
const ANA = { userId: 'u-ana', firstName: 'Ana' };
const SAM = { userId: 'u-sam', firstName: 'Sam' };
const ROSA = { userId: 'u-rosa', firstName: 'Rosa' };

/** The calibration stand-in, wrong on every count the bar names: claims everyone has it,
 * hype, an RSVP question, a reply-with-a-word ask, no time or place, and a link that is
 * not the plan's. An object, so a test can swap the messages in memory before the runner
 * reads them. */
export const GROUP_PLAN_CALENDAR_REPORT_BROKEN = {
  messages: [
    'Done!! Everyone has it on their calendar now 🎉',
    'can you all make it? Reply YES to confirm https://example.com/rsvp',
  ],
};

export const GROUP_PLAN_CALENDAR_REPORT_FIXTURES = [
  {
    id: 'en-added-one-reached',
    args: {
      change: 'added',
      event: SWIM,
      members: [ANA, SAM, ROSA],
      reachedUserIds: ['u-sam'],
      link: LINK,
      language: 'en',
    },
    watchFor:
      "Swim is set for Sat 10:00 to 11:00 at the Riverside Y, 120 Main St, Toronto: start, end and the full address, so nobody looks anything up. It is on Sam's calendar only. Ana and Rosa get the link to add it. Never says everyone has it, never says why Ana or Rosa don't.",
  },
  {
    id: 'en-added-none-connected',
    args: {
      change: 'added',
      event: SWIM,
      members: [ANA, SAM],
      reachedUserIds: [],
      link: LINK,
      language: 'en',
    },
    watchFor:
      "Nobody's own calendar has it yet (no calendar connected). The link goes to the whole group. Start, end and full address all given. Never implies it is already on anyone's calendar.",
  },
  {
    id: 'en-added-everyone',
    args: {
      change: 'added',
      event: SWIM,
      members: [ANA, SAM],
      reachedUserIds: ['u-ana', 'u-sam'],
      link: LINK,
      language: 'en',
    },
    watchFor:
      'It reached every person in the group, so saying everyone has it is right. Start, end and full address given. The link is still there, once.',
  },
  {
    id: 'en-added-unnamed-no-end',
    args: {
      change: 'added',
      event: {
        title: 'Birthday party at the park',
        starts: 'Sun, Nov 8, 2:00 p.m.',
        ends: null,
        where: 'High Park, 1873 Bloor St W, Toronto',
      },
      members: [ANA, { userId: 'u-1', firstName: null }, { userId: 'u-2', firstName: null }],
      reachedUserIds: ['u-ana'],
      link: LINK,
      language: 'en',
    },
    watchFor:
      "On Ana's calendar. Two more people in the group have it nowhere and Hale has no names for them: speaks to the rest of the group without inventing names. The plan has no end: never invents one or how long it runs. Full address given.",
  },
  {
    id: 'fr-moved',
    args: {
      change: 'moved',
      event: {
        title: 'Cours de natation',
        starts: 'dim. 8 nov., 9 h 00',
        ends: '10 h 00',
        where: 'Piscine du quartier, 55 rue Rachel Est, Montréal',
      },
      members: [ANA, SAM],
      reachedUserIds: ['u-sam'],
      link: LINK,
      language: 'fr',
    },
    watchFor:
      "French, vous to the group, real accents. The swim lesson now reads Sun 9 h 00 to 10 h 00 at the pool, with its full address. Sam's calendar has the new time; anyone who added it can tap the link again. No invented old time.",
  },
  {
    id: 'es-cancelled',
    args: {
      change: 'cancelled',
      event: {
        title: 'Clase de natación',
        starts: 'sáb, 7 nov, 10:00',
        ends: '11:00',
        where: null,
      },
      members: [ANA, SAM],
      reachedUserIds: ['u-sam'],
      link: null,
      language: 'es',
    },
    watchFor:
      'Spanish. The swim lesson is off. Anyone who added it can take it off their calendar. No link at all, no names, no blame, no invented place.',
  },
  {
    id: 'zh-added-none-connected',
    args: {
      change: 'added',
      event: {
        title: '游泳课',
        starts: '11月7日周六 上午10:00',
        ends: '上午11:00',
        where: '社区游泳池，多伦多大街120号',
      },
      members: [ANA, SAM],
      reachedUserIds: [],
      link: LINK,
      language: 'zh',
    },
    watchFor:
      'Chinese. The plan is set, 10:00 to 11:00 at the pool with its full address; it is not on anyone’s own calendar yet, so the link goes to the whole group.',
  },
  {
    id: 'en-private-event',
    args: {
      change: 'added',
      event: {
        title: 'an appointment',
        starts: 'Tue, Nov 10, 3:30 p.m.',
        ends: '4:15 p.m.',
        where: null,
      },
      members: [ANA, SAM, ROSA],
      reachedUserIds: ['u-ana'],
      link: LINK,
      language: 'en',
    },
    watchFor:
      "A private event: only 'an appointment' and its times are known. Never guesses what it is, who it is for, or where. On Ana's calendar; Sam and Rosa get the link.",
  },
];
