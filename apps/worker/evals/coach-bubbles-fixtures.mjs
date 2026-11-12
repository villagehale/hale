// One coach answer as several short iMessage bubbles (coach-bubbles skill, lit 1:1 turn).
//
// Each case is one text in a parent's own iMessage chat with COACH_BUBBLES_ENABLED lit.
// The objective metrics read only the SHAPE of what would be sent (coach-bubbles-grade.mjs);
// the judge reads the meaning against `rubric`. Families, places, times and the one name a
// parent types are fictional (the repo is public).

export const COACH_BUBBLES_NOW = '2026-11-12T17:00:00.000Z';
export const COACH_BUBBLES_TIME_ZONE = 'America/Toronto';

const TORONTO = { city: 'Toronto', province: 'ON', country: 'Canada' };

const TODDLER = {
  id: 'child-toddler',
  stage: 'toddler',
  name: null,
  ageMonths: 20,
  teenRedacted: false,
};
const PRESCHOOLER = {
  id: 'child-preschool',
  stage: 'preschool',
  name: null,
  ageMonths: 38,
  teenRedacted: false,
};
/** As the coach context carries a 13+ child: stage only. */
const TEEN = { id: 'child-teen', stage: 'teen', name: null, ageMonths: 170, teenRedacted: true };

const WINTER_SWIM = [
  {
    title: 'Parent and tot swim',
    kind: 'class',
    summary: 'Ages 6 to 36 months with a parent in the water. Registration opens Dec 1 at 7:00.',
    venue: 'Wellesley Community Centre pool',
    when: 'Saturdays 9:30, Jan 9 to Mar 13',
    url: 'https://www.toronto.ca/fixture/parent-and-tot-swim',
  },
  {
    title: 'Little splashers',
    kind: 'class',
    summary: 'Ages 12 to 36 months, parent in the water. Registration opens Dec 1 at 7:00.',
    venue: 'Regent Park Aquatic Centre',
    when: 'Sundays 10:15, Jan 10 to Mar 14',
    url: 'https://www.toronto.ca/fixture/little-splashers',
  },
];

const SATURDAY_PICKS = [
  {
    title: 'Story time and songs',
    kind: 'drop_in',
    summary: 'Free drop-in for ages 2 to 5.',
    venue: 'Riverdale Library',
    when: 'Sat, Nov 14, 10:30',
    url: 'https://www.torontopubliclibrary.ca/fixture/story-time-and-songs',
  },
  {
    title: 'Family open gym',
    kind: 'drop_in',
    summary: 'Indoor play gym, $4 per child, ages 1 to 6.',
    venue: 'Pape Recreation Centre',
    when: 'Sat, Nov 14, 1:00 to 3:00',
    url: 'https://www.toronto.ca/fixture/family-open-gym',
  },
];

const SUNDAY_INDOOR = [
  {
    title: 'Toddler music circle',
    kind: 'drop_in',
    summary: 'Indoor, ages 1 to 3, free.',
    venue: 'Danforth Library',
    when: 'Sun, Nov 15, 2:00',
    url: 'https://www.torontopubliclibrary.ca/fixture/toddler-music-circle',
  },
];

const SWIM_EVENT = {
  eventId: 'evt-swim-sat',
  title: 'Swim lesson',
  startsAt: '2026-11-14T15:00:00.000Z',
  endsAt: '2026-11-14T15:45:00.000Z',
  location: 'Pape Recreation Centre',
};

const BUSY_WEEK = [
  { eventId: 'evt-1', title: 'Daycare pickup', startsAt: '2026-11-16T21:30:00.000Z' },
  { eventId: 'evt-2', title: 'Swim lesson', startsAt: '2026-11-17T22:00:00.000Z' },
  { eventId: 'evt-3', title: 'Pediatrician checkup', startsAt: '2026-11-18T14:15:00.000Z' },
  { eventId: 'evt-4', title: 'Daycare pickup', startsAt: '2026-11-18T21:30:00.000Z' },
  { eventId: 'evt-5', title: 'Music class', startsAt: '2026-11-19T23:00:00.000Z' },
  { eventId: 'evt-6', title: 'Birthday party', startsAt: '2026-11-21T18:00:00.000Z' },
];

export const COACH_BUBBLES_FIXTURES = [
  {
    id: 'zh-winter-swim',
    text: '我家宝宝20个月，冬天想找个游泳课，有推荐吗？',
    children: [TODDLER],
    location: TORONTO,
    village: WINTER_SWIM,
    rubric:
      'Every bubble is in Chinese (program and venue names may stay as given). Both swim classes are named as given with their day and time, and the registration opening (Dec 1 at 7:00) is said. One thought per bubble.',
  },
  {
    id: 'en-thanks',
    text: 'perfect, thank you!',
    children: [TODDLER],
    location: TORONTO,
    transcript: [
      { role: 'user', content: 'when is swim saturday' },
      { role: 'assistant', content: 'Swim is Saturday at 10 at Pape Recreation Centre.' },
    ],
    maxBubbles: 1,
    rubric:
      'A thank-you gets a short acknowledgement and nothing more: one bubble, no question, no offer to help again.',
  },
  {
    id: 'fr-move-swim',
    text: 'Tu peux déplacer la natation de samedi à dimanche, même heure ?',
    children: [PRESCHOOLER],
    location: TORONTO,
    events: [SWIM_EVENT],
    draftedWhen: 'Sun, Nov 15, 10:00',
    rubric:
      'Every bubble is in French. The move to Sunday at 10:00 was drafted; the only question asks them to confirm it, and it is in the last bubble.',
  },
  {
    id: 'es-two-picks',
    text: '¿Qué hay para hacer este sábado con mi hija de 3 años?',
    children: [PRESCHOOLER],
    location: TORONTO,
    village: SATURDAY_PICKS,
    rubric:
      'Every bubble is in Spanish (names may stay as given). Both Saturday picks are named as given with their own time. No bubble is a count of what follows.',
  },
  {
    id: 'en-capability-no',
    text: 'can you order diapers on amazon for me',
    children: [TODDLER],
    location: TORONTO,
    rubric:
      'A plain no to a thing Hale does not do, said briefly in a friend register. One bubble is right here; it must not list what Hale does instead.',
  },
  {
    id: 'zh-after-english-thread',
    text: '那周日下午有什么室内活动吗？',
    children: [TODDLER],
    location: TORONTO,
    transcript: [
      { role: 'user', content: 'what time is swim saturday' },
      { role: 'assistant', content: 'Swim is Saturday at 10 at Pape Recreation Centre.' },
    ],
    village: SUNDAY_INDOOR,
    rubric:
      'The earlier thread was English, but this text is Chinese: every bubble is in Chinese (names may stay as given). The Sunday pick is named as given with its time.',
  },
  {
    id: 'en-teen-shift',
    text: 'Wren has a shift at the rink Saturday 4 to 8, can you put it on the calendar?',
    children: [TEEN],
    replyChildren: [{ name: 'Wren', gender: 'girl', dateOfBirth: '2012-09-01' }],
    neverSays: ['Wren'],
    location: TORONTO,
    events: [],
    draftedWhen: 'Sat, Nov 14, 4:00 to 8:00',
    rubric:
      'The shift was drafted for Saturday 4 to 8; the only question asks them to confirm it, and it is in the last bubble. The 13+ child is never named.',
  },
  {
    id: 'en-busy-week',
    text: 'what does our week look like? I need to plan around work',
    children: [TODDLER],
    location: TORONTO,
    events: BUSY_WEEK,
    rubric:
      'The week is given from the calendar without inventing anything. Not over-split: a bubble is a whole thought (a day or a stretch of days), never a fragment. No bubble is a count or a heading of what follows.',
  },
];
