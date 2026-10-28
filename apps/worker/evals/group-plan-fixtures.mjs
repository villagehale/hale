// Plan-together reader + writer corpus (VIL-441). Judges score meaning, 1-5.
//
// Reader fixtures use the REAL `groupPlanUserMessage` shape. `accept` is the set of
// intents that read the meaning correctly. No word in the message is checked.
// Writer fixtures give `purpose` + facts; the judge scores the spoken line.

const SWIM = [
  { id: '1', name: 'Saturday parent-and-tot swim', when: 'Saturdays 9:15am', where: 'Elm rec centre' },
  { id: '2', name: 'Sunday family swim', when: 'Sundays 11am', where: 'Riverside pool' },
];

export const GROUP_PLAN_READ_FIXTURES = [
  {
    id: 'en-plan-ask',
    input: {
      text: 'hale can you find us something to do saturday morning',
      reactionType: null,
      senderName: 'Priya',
      options: [],
      answered: [],
    },
    accept: ['plan_ask'],
  },
  {
    id: 'en-mixed-yes',
    input: {
      text: 'count us in for the first one if it is still open',
      reactionType: null,
      senderName: 'Jordan',
      options: SWIM,
      answered: [{ name: 'Priya', stance: 'yes' }],
    },
    accept: ['yes'],
  },
  {
    id: 'en-maybe',
    input: {
      text: 'maybe, depends on nap',
      reactionType: null,
      senderName: 'Mei',
      options: SWIM,
      answered: [],
    },
    accept: ['maybe'],
  },
  {
    id: 'en-mind-change',
    input: {
      text: 'actually sunday works better, switch us',
      reactionType: null,
      senderName: 'Jordan',
      options: SWIM,
      answered: [{ name: 'Jordan', stance: 'yes' }],
    },
    accept: ['yes'],
  },
  {
    id: 'en-tapback-yes',
    input: {
      text: '',
      reactionType: 'like',
      senderName: 'Sam',
      options: SWIM,
      answered: [],
    },
    accept: ['yes'],
  },
  {
    id: 'en-non-member-yes',
    input: {
      text: 'we are in too',
      reactionType: null,
      senderName: null,
      options: SWIM,
      answered: [],
    },
    accept: ['yes'],
  },
  {
    id: 'en-chatter',
    input: {
      text: 'lol wait who is picking up from school',
      reactionType: null,
      senderName: 'Priya',
      options: SWIM,
      answered: [],
    },
    accept: ['chatter'],
  },
  {
    id: 'fr-maybe',
    input: {
      text: 'peut-etre, on verra apres la sieste',
      reactionType: null,
      senderName: 'Camille',
      options: SWIM,
      answered: [],
    },
    accept: ['maybe'],
  },
  {
    id: 'zh-plan-ask',
    input: {
      text: 'Hale，帮我们找周六能一起去的游泳',
      reactionType: null,
      senderName: '婷',
      options: [],
      answered: [],
    },
    accept: ['plan_ask'],
  },
];

export const GROUP_PLAN_VOICE_FIXTURES = [
  {
    id: 'en-options',
    purpose: 'group_plan_options',
    language: 'en',
    facts: {
      topic: 'saturday swim',
      options:
        '1. Saturday parent-and-tot swim · Saturdays 9:15am · Elm rec centre · $8 drop-in · https://example.test/elm-swim\n2. Sunday family swim · Sundays 11am · Riverside pool · $12 · https://example.test/riverside',
      deadline: '2026-10-30T16:00:00.000Z',
      yes: '',
      no: '',
      maybe: '',
      unanswered: '',
      winning: '',
    },
    watchFor: 'Must carry both option names and not invent a time or a poll.',
  },
  {
    id: 'en-followup',
    purpose: 'group_plan_followup',
    language: 'en',
    facts: {
      topic: 'saturday swim',
      options: '1. Saturday parent-and-tot swim',
      deadline: '2026-10-30T16:00:00.000Z',
      yes: 'Priya',
      no: '',
      maybe: 'Mei',
      unanswered: 'Sam',
      winning: '',
    },
    watchFor: 'Must name Sam. Must not invent that Sam said yes.',
  },
  {
    id: 'fr-progress',
    purpose: 'group_plan_progress',
    language: 'fr',
    facts: {
      topic: 'natation',
      options: '1. Natation parent-enfant',
      deadline: '',
      yes: 'Priya, Jordan',
      no: '',
      maybe: 'Mei',
      unanswered: '',
      winning: 'Natation parent-enfant',
    },
    watchFor: 'French, names Priya/Jordan/Mei, does not invent availability.',
  },
];
