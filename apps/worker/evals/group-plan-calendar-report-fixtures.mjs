// The group plan report — the corpus (VIL-443 T17).
//
// Expectations come from the SPEC (packages/agent/skills/group-plan-calendar-report.md)
// and the ticket: one text into the family group after its plan is placed, moved or
// called off, saying whose own calendars it reached, who it is not on yet, and handing
// the add-to-calendar link. Its eval cases are here: an edit or cancel reaching every
// copy (moved, cancelled) and a family with no calendar connected. Duplicate invites
// are structural (one send per revision) and live in the pglite tests, not here.
// No fixed copy and no wording checks: a judge reads facts and tone. en, fr, es, zh.

const LINK =
  'https://app.villagehale.com/api/ics/event/5d0e3a52-1b7c-4f0e-9a51-0c3f7b2a9e41.Qm9vZ3lHcm91cA';
const SWIM = { title: 'Swim lesson', when: 'Sat, Nov 7, 10:00 a.m.', where: 'Y on Main' };
const ANA = { userId: 'u-ana', firstName: 'Ana' };
const SAM = { userId: 'u-sam', firstName: 'Sam' };
const ROSA = { userId: 'u-rosa', firstName: 'Rosa' };

/** The calibration stand-in, wrong on every count the bar names: claims everyone has it,
 * hype, an RSVP question, a reply-with-a-word ask, and a link that is not the plan's. An
 * object, so a test can swap the text in memory before the runner reads it. */
export const GROUP_PLAN_CALENDAR_REPORT_BROKEN = {
  text: 'Done!! Everyone has it on their calendar now 🎉 can you all make it? Reply YES to confirm https://example.com/rsvp',
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
      "Swim is set for Sat 10:00 at Y on Main. It is on Sam's calendar only. Ana and Rosa get the link to add it. Never says everyone has it, never says why Ana or Rosa don't.",
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
      "Nobody's own calendar has it yet (no calendar connected). The link goes to the whole group. Never implies it is already on anyone's calendar.",
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
      'It reached every person in the group, so saying everyone has it is right. The link is still in the text, once.',
  },
  {
    id: 'en-added-unnamed-others',
    args: {
      change: 'added',
      event: {
        title: 'Birthday party at the park',
        when: 'Sun, Nov 8, 2:00 p.m.',
        where: 'High Park',
      },
      members: [ANA, { userId: 'u-1', firstName: null }, { userId: 'u-2', firstName: null }],
      reachedUserIds: ['u-ana'],
      link: LINK,
      language: 'en',
    },
    watchFor:
      "On Ana's calendar. Two more people in the group have it nowhere and Hale has no names for them: speaks to the rest of the group without inventing names.",
  },
  {
    id: 'fr-moved',
    args: {
      change: 'moved',
      event: {
        title: 'Cours de natation',
        when: 'dim. 8 nov., 9 h 00',
        where: 'Piscine du quartier',
      },
      members: [ANA, SAM],
      reachedUserIds: ['u-sam'],
      link: LINK,
      language: 'fr',
    },
    watchFor:
      "French, vous to the group, real accents. The swim lesson now reads Sun 9 h 00. Sam's calendar has the new time; anyone who added it can tap the link again. No invented old time.",
  },
  {
    id: 'es-cancelled',
    args: {
      change: 'cancelled',
      event: { title: 'Clase de natación', when: 'sáb, 7 nov, 10:00', where: null },
      members: [ANA, SAM],
      reachedUserIds: ['u-sam'],
      link: null,
      language: 'es',
    },
    watchFor:
      'Spanish. The swim lesson is off. Anyone who added it can take it off their calendar. No link at all, no names, no blame.',
  },
  {
    id: 'zh-added-none-connected',
    args: {
      change: 'added',
      event: { title: '游泳课', when: '11月7日周六 上午10:00', where: '社区游泳池' },
      members: [ANA, SAM],
      reachedUserIds: [],
      link: LINK,
      language: 'zh',
    },
    watchFor:
      'Chinese. The plan is set; it is not on anyone’s own calendar yet, so the link goes to the whole group.',
  },
  {
    id: 'en-private-event',
    args: {
      change: 'added',
      event: { title: 'an appointment', when: 'Tue, Nov 10, 3:30 p.m.', where: null },
      members: [ANA, SAM, ROSA],
      reachedUserIds: ['u-ana'],
      link: LINK,
      language: 'en',
    },
    watchFor:
      "A private event: only 'an appointment' and the time are known. Never guesses what it is, who it is for, or where. On Ana's calendar; Sam and Rosa get the link.",
  },
];
