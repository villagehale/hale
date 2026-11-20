/**
 * VIL-399 — the ten Barton-approved group-chat scenes.
 *
 * Mockup lines are tone, not templates. The judge scores meaning. The runner
 * never asserts a phrase. Scene 01 reuses the existing group hello. Scene 06
 * reuses the existing carpool path. Scene 10 reuses shared lists.
 */

export const GROUP_EXPERIENCE_SCENE_FIXTURES = [
  {
    scene: '01',
    id: 'hello',
    kind: 'hello',
    audience: 'group',
    questions: 0,
    situation: 'Hale has just been added to a group and says a short hello.',
    accept: ['hello'],
    facts: {},
    watchFor: 'A short hello. No ask. No URL.',
  },
  {
    scene: '02',
    id: 'rsvp-open',
    kind: 'rsvp_open',
    audience: 'group',
    questions: 1,
    situation:
      'A parent wants the group to say whether they are coming Saturday. A native poll card will follow when LINQ_POLLS is on.',
    accept: ['rsvp_open'],
    input: {
      text: 'Hale can you see who is in for Saturday picnic',
      senderName: 'Priya',
      live: { rsvp: null, time: null, link: null },
      urls: [],
      recent: [],
    },
    facts: { card: true, title: 'Saturday picnic' },
    watchFor: 'One ask whether they are coming. No typed Yes/No/Maybe instructions.',
  },
  {
    scene: '03',
    id: 'time-open-lock',
    kind: 'time_open',
    audience: 'group',
    questions: 1,
    situation: 'The group needs to pick Saturday 10 or Sunday 10, then Hale locks the winner.',
    accept: ['time_open', 'time_lock'],
    input: {
      text: 'Hale poll Saturday 10 or Sunday 10',
      senderName: 'Sam',
      live: { rsvp: { title: 'picnic' }, time: null, link: null },
      urls: [],
      recent: [],
    },
    facts: {
      card: true,
      options: ['Saturday 10', 'Sunday 10'],
      title: 'picnic',
    },
    watchFor: 'One ask to pick a time. Later lock names the winning time from facts.',
  },
  {
    scene: '04',
    id: 'rsvp-tally-calendars',
    kind: 'rsvp_tally',
    audience: 'group',
    questions: 0,
    situation:
      'Three families said yes and one said no. Hale tallies that and only the yes families get the event on their calendar.',
    accept: ['rsvp_tally'],
    input: {
      text: 'where do we stand',
      senderName: 'Priya',
      live: { rsvp: { title: 'picnic' }, time: null, link: null },
      urls: [],
      recent: [],
    },
    facts: {
      title: 'picnic',
      yesCount: 3,
      noCount: 1,
      maybeCount: 0,
      yesNames: ['Patels', 'Nguyens', 'Okafor'],
      noNames: ['Diaz'],
      maybeNames: [],
      waitingNames: [],
      toGo: 0,
    },
    watchFor: 'The live yes/no picture. No calendar of another family named.',
  },
  {
    scene: '05',
    id: 'link-facts-then-1to1',
    kind: 'link_facts',
    audience: 'group',
    questions: 0,
    situation:
      'Someone posted a class link. Hale says the public facts (price, sessions, spots) in the group, then registration continues in each family 1:1.',
    accept: ['link_facts'],
    input: {
      text: 'this camp https://park.example/camp is $120, two sessions, 4 spots left',
      senderName: 'Maya',
      live: { rsvp: null, time: null, link: null },
      urls: ['https://park.example/camp'],
      recent: [],
    },
    facts: {
      publicText: 'this camp https://park.example/camp is $120, two sessions, 4 spots left',
      url: 'https://park.example/camp',
    },
    watchFor: 'Public facts only. No login. No payment. No ask in the group.',
  },
  {
    scene: '06',
    id: 'carpool',
    kind: 'carpool',
    audience: 'group',
    questions: 1,
    situation: 'The group is working out who picks up from soccer. Existing carpool path.',
    accept: ['driver_claim', 'ask_driver'],
    facts: { eventLabel: 'soccer' },
    watchFor: 'One ask about who is driving. Existing carpool skill, not this one.',
  },
  {
    scene: '07',
    id: 'mail-notice',
    kind: 'mail_notice',
    audience: 'group',
    questions: 0,
    situation:
      'A same-family group (mom, dad, grandma). Gmail said the class moved from 3pm to 4pm. Hale posts that into the household group.',
    accept: ['mail_notice'],
    facts: {
      title: 'swim',
      field: 'time',
      previousStartsAt: '2026-11-14T20:00:00.000Z',
      startsAt: '2026-11-14T21:00:00.000Z',
    },
    watchFor: 'The new time. No login. Household group only.',
  },
  {
    scene: '08',
    id: 'private-hold',
    kind: 'private_hold',
    audience: 'group',
    questions: 0,
    situation:
      'Someone asked about a peanut allergy in a multi-family group. Hale does not answer that in the group.',
    accept: ['private_question'],
    input: {
      text: 'does the snack have peanuts? Mira is allergic',
      senderName: 'Priya',
      live: { rsvp: null, time: null, link: null },
      urls: [],
      recent: [],
    },
    facts: {},
    watchFor: 'Will text them. Does not name the allergy, a child, or a diagnosis.',
  },
  {
    scene: '09',
    id: 'private-1to1',
    kind: 'private_1to1',
    audience: 'one_to_one',
    questions: 0,
    situation: 'The peanut-allergy question is answered in that family 1:1.',
    accept: ['private_question'],
    facts: {
      asked: 'does the snack have peanuts? Mira is allergic',
      private: { memory: ['Mira peanut allergy'], children: ['Mira'] },
    },
    watchFor: 'Answers the allergy in 1:1. Not a group line.',
  },
  {
    scene: '10',
    id: 'bring-list',
    kind: 'bring_list',
    audience: 'group',
    questions: 0,
    situation: 'A bring-list of who brings which snack. Existing shared-list path.',
    accept: ['list_claim', 'list_tally'],
    facts: { item: 'orange slices', who: 'Patels' },
    watchFor: 'Who is bringing what. Existing lists skill, not this one.',
  },
];

export const GROUP_EXPERIENCE_READ_FIXTURES = GROUP_EXPERIENCE_SCENE_FIXTURES.filter(
  (fixture) => fixture.input,
);

export const GROUP_EXPERIENCE_VOICE_FIXTURES = GROUP_EXPERIENCE_SCENE_FIXTURES.filter(
  (fixture) =>
    fixture.kind !== 'carpool' && fixture.kind !== 'bring_list' && fixture.kind !== 'hello',
);
